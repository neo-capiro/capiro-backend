#!/usr/bin/env bash
# Self-contained end-to-end rehearsal for
# replace-defense-budget-candidate-approvals-v1.ts -- disposable Postgres
# only (no MinIO: every fixture candidate uses a plain filesystem
# extraction-artifact locator, which the production byte-locator reader
# already supports for local paths). Own container, own port, always torn
# down. Modeled on scripts/phase10b35c-candidate-correction-e2e-rehearsal.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUFFIX="$RANDOM-$$"
PG_NAME="capiro-replace-approvals-e2e-pg-$SUFFIX"
PG_PORT="${REPLACE_APPROVALS_PG_PORT:-0}"
PASSWORD="replace-approvals-rehearsal"

cleanup() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting disposable Postgres ($PG_NAME)..." >&2
if [[ "$PG_PORT" == "0" ]]; then
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16 >/dev/null
  PG_PORT="$(docker port "$PG_NAME" 5432/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$PG_NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "$PG_PORT:5432" pgvector/pgvector:pg16 >/dev/null
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

export DATABASE_URL="postgresql://postgres:${PASSWORD}@localhost:${PG_PORT}/capiro"
echo "Postgres ready at localhost:${PG_PORT}. Applying migrations..." >&2

npx prisma migrate deploy >/dev/null
echo "Migrations applied. Running the replace-defense-budget-candidate-approvals-v1 end-to-end spec (includes a REAL SIGKILL mid-manifest + resume proof)..." >&2

JEST_CACHE_DIR="${REPLACE_APPROVALS_JEST_CACHE_DIR:-/tmp/replace-approvals-jestcache}"
node --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand --forceExit \
  --cacheDirectory "$JEST_CACHE_DIR" \
  scripts/replace-defense-budget-candidate-approvals-v1.integration.spec.ts
