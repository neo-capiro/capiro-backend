#!/usr/bin/env bash
# Phase 10B-35c -- self-contained end-to-end rehearsal: real corrected
# extraction -> formal candidate-correction link -> real supersession of a
# real active scoped approval -> serving read API, against a disposable
# Postgres and a disposable versioned MinIO archive. Modeled directly on
# scripts/phase10b35-scoped-review-e2e-rehearsal.sh (own containers, own
# ports, always torn down).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUFFIX="$RANDOM-$$"
PG_NAME="capiro-phase10b35c-e2e-pg-$SUFFIX"
MINIO_NAME="capiro-phase10b35c-e2e-minio-$SUFFIX"
PG_PORT="${PHASE10B35C_PG_PORT:-0}"
MINIO_PORT="${PHASE10B35C_MINIO_PORT:-0}"
# Immutable multi-architecture digest resolved from the official Quay image.
# Override only for an explicitly reviewed mirror/version.
MINIO_IMAGE="${PHASE10B35C_MINIO_IMAGE:-quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e}"
PASSWORD="phase10b35c-rehearsal"
MINIO_USER="phase10b35c"
MINIO_PASSWORD="phase10b35c-isolated-archive"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker rm -f "$MINIO_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting disposable Postgres ($PG_NAME)..." >&2
if [[ "$PG_PORT" == "0" ]]; then
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16 >/dev/null
  PG_PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
fi

echo "Starting disposable versioned MinIO ($MINIO_NAME)..." >&2
if [[ "$MINIO_PORT" == "0" ]]; then
  docker run -d --name "$MINIO_NAME" -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" -p 0:9000 "$MINIO_IMAGE" server /data >/dev/null
  MINIO_PORT="$(docker port "$MINIO_NAME" 9000/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$MINIO_NAME" -e MINIO_ROOT_USER="$MINIO_USER" -e MINIO_ROOT_PASSWORD="$MINIO_PASSWORD" -p "$MINIO_PORT:9000" "$MINIO_IMAGE" server /data >/dev/null
fi

pg_ok=0
for _ in $(seq 1 60); do
  if docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; then pg_ok=1; sleep 1; break; fi
  sleep 1
done
if [[ "$pg_ok" != "1" ]]; then
  echo "Postgres never became ready" >&2
  exit 1
fi

minio_ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:${MINIO_PORT}/minio/health/live" >/dev/null 2>&1; then minio_ok=1; break; fi
  sleep 1
done
if [[ "$minio_ok" != "1" ]]; then
  echo "MinIO never became ready" >&2
  exit 1
fi

export DATABASE_URL="postgresql://postgres:${PASSWORD}@localhost:${PG_PORT}/capiro"
export BUDGET_VERIFICATION_S3_ENDPOINT="http://localhost:${MINIO_PORT}"
export AWS_ACCESS_KEY_ID="$MINIO_USER"
export AWS_SECRET_ACCESS_KEY="$MINIO_PASSWORD"
export AWS_REGION="${AWS_REGION:-us-east-1}"
unset AWS_PROFILE AWS_SESSION_TOKEN BUDGET_VERIFICATION_EXTRACTION_ARTIFACT_BUCKET
echo "Postgres ready at localhost:${PG_PORT}; MinIO ready at localhost:${MINIO_PORT}. Building workspace dependency and generating Prisma Client..." >&2

pnpm --filter @capiro/defense-domain build >/dev/null
parser_sync_args=(--frozen --project "$ROOT/../defense-budget-parser" --extra camelot)
# Camelot's stream path used by this fixture does not need pdftopng. That
# transitive package publishes no Windows wheel/source archive, so exclude it
# only on Git Bash/Windows; Linux rehearsals retain the complete locked extra.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) parser_sync_args+=(--no-install-package pdftopng) ;;
esac
uv sync "${parser_sync_args[@]}" >/dev/null
npx prisma validate >/dev/null
npx prisma generate >/dev/null
echo "Workspace dependency/client ready. Applying migrations..." >&2
npx prisma migrate deploy >/dev/null
echo "Migrations applied. Running the Phase 10B-35c candidate-correction end-to-end spec..." >&2

JEST_CACHE_DIR="${PHASE10B35C_JEST_CACHE_DIR:-/tmp/phase10b35c-jestcache}"
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit \
  --cacheDirectory "$JEST_CACHE_DIR" \
  src/defense-budget/governed-acceptance/candidate-correction/phase10b35c-candidate-correction-e2e.integration.spec.ts
