#!/bin/sh
# Native, disposable PostgreSQL qualification of the exact candidate and source.
set -eu
image=${1:?Usage: run-bill-postgres-probes.sh <locally-built-candidate-image>}
case "$(uname -m)" in aarch64|arm64) ;; *) echo 'Native ARM64 host required' >&2; exit 64 ;; esac
test "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = linux/arm64
pg_image=pgvector/pgvector:pg16@sha256:016a18f2a5269b23ca05de83826094011cc4e1a9e9cb28c186a3ba9f079ef1d9
run_id="bill-pg-$(date +%s)-$$"
builder="$run_id:build"
pg_id=
network_id=
cleanup() {
  docker rm -f "$run_id-runtime" "$run_id-tests" "$run_id-api-tests" >/dev/null 2>&1 || true
  test -z "$pg_id" || docker rm -f "$pg_id" >/dev/null 2>&1 || true
  test -z "$network_id" || docker network rm "$network_id" >/dev/null 2>&1 || true
  docker image rm "$builder" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The cache comes from the same Dockerfile/source as the runtime build. This
# local development-tooling image is never pushed or admitted as a runtime.
docker build --platform linux/arm64 --target build -f apps/api/Dockerfile.alpine-qualification -t "$builder" .
docker pull --platform linux/arm64 "$pg_image"
network_id=$(docker network create --internal "$run_id")
# Synthetic password is local to this isolated, portless namespace. No host env,
# credentials, application secrets, or volumes enter any test container.
pg_id=$(docker run -d --name "$run_id" --network "$network_id" --memory 1g \
  --security-opt no-new-privileges --pids-limit 256 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=768m \
  -e POSTGRES_PASSWORD=bill_fixture -e POSTGRES_DB=bill_test "$pg_image")
attempt=0
until docker exec "$pg_id" pg_isready -U postgres -d bill_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60 || { docker logs "$pg_id"; exit 1; }
  sleep 1
done
docker exec "$pg_id" createdb -U postgres bill_text_test
docker exec "$pg_id" createdb -U postgres bill_structured_test
docker exec "$pg_id" createdb -U postgres bill_document_test
docker exec "$pg_id" psql -U postgres -d bill_text_test -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION vector'
docker run --rm --name "$run_id-runtime" --read-only --network "container:$pg_id" --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 1g \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m --shm-size 128m \
  -e CAPIRO_DISPOSABLE_PG=1 -e DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_test \
  --entrypoint /usr/bin/dumb-init "$image" -- \
  node --import tsx scripts/bill-text-postgres-smoke.ts

# The Docker build stage intentionally omits test harness files. Mount only the
# committed harness from this verified source, read-only, without changing it.
set --
for name in jest.config.cjs jest.native-runtime-environment.cjs jest.native-sanitize-html.cjs jest.native-tango.cjs jest.worker-database.cjs jest.setup.ts; do
  harness="apps/api/$name"
  test -f "$harness" || { echo "Missing tracked Jest harness: $harness" >&2; exit 1; }
  set -- "$@" --mount "type=bind,src=$(pwd)/$harness,dst=/workspace/$harness,readonly"
done
docker run --rm --name "$run_id-tests" --read-only --network "container:$pg_id" --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 3g \
  --tmpfs /tmp:rw,nosuid,size=512m -w /workspace/apps/api \
  -e CAPIRO_DISPOSABLE_PG=1 \
  -e BILL_TEXT_PG_DIAGNOSTICS="${BILL_TEXT_PG_DIAGNOSTICS:-1}" \
  -e LEGIWATCH_PHASE5_TEST_DATABASE=disposable \
  -e BILL_DOCUMENT_TEST_DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_document_test \
  -e DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_structured_test \
  -e BILL_TEXT_SEARCH_TEST_DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_text_test \
  -e BILL_STATE_WRITER_TEST_DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_text_test \
  "$@" --entrypoint node "$builder" --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runInBand --runTestsByPath src/retrieval/bill-text.pg.spec.ts \
  src/ingestion/state-bill-writer.pg.spec.ts src/ingestion/state-document-queue.pg.spec.ts \
  src/ingestion/legiscan-provider-capacity.pg.spec.ts \
  src/ingestion/bill-text-extraction-postgres.spec.ts \
  src/ingestion/legiscan-document-evidence-postgres.spec.ts

# Preserve the API's deployed mail, SQL-reader and semantic/memory behavior on
# the same candidate build stage. Their existing local-only harness requires
# IPv4 loopback port 55433. It is private to this disposable container namespace;
# no host port is published. Separate databases keep the destructive fixtures apart.
docker rm -f "$pg_id" >/dev/null
pg_id=
pg_id=$(docker run -d --name "$run_id-api-pg" --network "$network_id" --memory 1g \
  --security-opt no-new-privileges --pids-limit 256 \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,size=768m \
  -e POSTGRES_PASSWORD=api_fixture -e POSTGRES_DB=api_memory_test "$pg_image" -p 55433)
attempt=0
until docker exec "$pg_id" pg_isready -p 55433 -U postgres -d api_memory_test >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  test "$attempt" -lt 60 || { docker logs "$pg_id"; exit 1; }
  sleep 1
done
docker exec "$pg_id" createdb -p 55433 -U postgres api_mail_test
docker exec "$pg_id" createdb -p 55433 -U postgres api_reader_test
docker exec "$pg_id" createdb -p 55433 -U postgres api_keyword_test
memory_harness=apps/api/test/memory-postgres-qualification/harness.ts
test -f "$memory_harness" || { echo "Missing tracked memory harness: $memory_harness" >&2; exit 1; }
docker run --rm --name "$run_id-api-tests" --read-only --network "container:$pg_id" --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 3g \
  --tmpfs /tmp:rw,nosuid,size=512m -w /workspace/apps/api \
  -e DATABASE_URL=postgresql://postgres:api_fixture@127.0.0.1:55433/api_memory_test \
  -e CAPIRO_DATA_TEST_DATABASE_URL=postgresql://postgres:api_fixture@127.0.0.1:55433/api_reader_test \
  -e MEMORY_POSTGRES_ADMIN_URL=postgresql://postgres:api_fixture@127.0.0.1:55433/api_memory_test \
  -e MEMORY_POSTGRES_OWNED_ENDPOINT_ACK=127.0.0.1:55433 \
  -e MEMORY_POSTGRES_REQUIRE_VECTOR=1 \
  -e MERI_APPROVED_MEMORY_PG_CONFIG=/tmp/api-mail-postgres.json \
  "$@" --mount "type=bind,src=$(pwd)/$memory_harness,dst=/workspace/$memory_harness,readonly" \
  --entrypoint /bin/sh "$builder" -ec '
    umask 077
    printf "%s\n" "{\"host\":\"127.0.0.1\",\"port\":55433,\"database\":\"api_mail_test\",\"user\":\"postgres\",\"password\":\"api_fixture\",\"scope\":\"owned local disposable test cluster; no AWS connection\"}" > "$MERI_APPROVED_MEMORY_PG_CONFIG"
    node --experimental-vm-modules node_modules/jest/bin/jest.js \
      --runInBand --runTestsByPath src/engagement/mail-query-plan.postgres.spec.ts \
      src/meri/analytics/capiro-data-reader-roles.integration.spec.ts \
      src/meri/semantic-search.postgres.spec.ts \
      src/retrieval/adapters/memory-embedding-retention-policy.postgres.spec.ts
    # The keyword matcher owns only transaction-local temporary catalogs in its
    # separate synthetic database. Keep the preceding four fixture bindings intact.
    DATABASE_URL=postgresql://postgres:api_fixture@127.0.0.1:55433/api_keyword_test \
      CAPIRO_DISPOSABLE_PG=1 exec node --experimental-vm-modules node_modules/jest/bin/jest.js \
      --runInBand --runTestsByPath src/intelligence/bill-keyword-match.postgres.spec.ts \
      src/tenant/tenant-context.authority-mount.spec.ts \
      src/auth/capiro-throttler.guard.spec.ts \
      src/meri/meri-report-read-authorization.spec.ts \
      src/meri/meri-turn-lifecycle.phase4.spec.ts \
      src/meri/meri-workspace-scope.phase4.spec.ts \
      src/meri/meri.service.create-conversation.spec.ts \
      src/research-portfolios/research-portfolio-artifact-retrieval.spec.ts
  '
printf 'API_PRESERVATION_POSTGRES_QUALIFICATION_OK image=%s\n' "$image"
printf 'BILL_POSTGRES_QUALIFICATION_OK image=%s\n' "$image"
