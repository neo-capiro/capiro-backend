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
  docker rm -f "$run_id-runtime" "$run_id-tests" >/dev/null 2>&1 || true
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
for harness in apps/api/jest*.cjs apps/api/jest.setup.ts; do
  set -- "$@" --mount "type=bind,src=$(pwd)/$harness,dst=/workspace/$harness,readonly"
done
docker run --rm --name "$run_id-tests" --read-only --network "container:$pg_id" --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 256 --memory 3g \
  --tmpfs /tmp:rw,nosuid,size=512m -w /workspace/apps/api \
  -e CAPIRO_DISPOSABLE_PG=1 \
  -e DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_structured_test \
  -e BILL_TEXT_SEARCH_TEST_DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_text_test \
  -e BILL_STATE_WRITER_TEST_DATABASE_URL=postgresql://postgres:bill_fixture@localhost:5432/bill_text_test \
  "$@" --entrypoint node "$builder" --experimental-vm-modules node_modules/jest/bin/jest.js \
  --runInBand --runTestsByPath src/retrieval/bill-text.pg.spec.ts \
  src/ingestion/state-bill-writer.pg.spec.ts src/ingestion/bill-text-extraction-postgres.spec.ts
printf 'BILL_POSTGRES_QUALIFICATION_OK image=%s\n' "$image"
