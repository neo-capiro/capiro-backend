#!/usr/bin/env bash
# Phase 10B-31 -- self-contained qualification rehearsal for the
# lifecycle-bridge SourceDocument metadata-agreement fix.
#
# Provisions its OWN disposable pgvector/pgvector:pg16 Postgres container
# (never reuses another session's container on a shared machine), migrates
# BOTH prisma schemas this app actually uses (prisma/schema.prisma and
# prisma/phase6-projection/schema.prisma -- the second is required by other
# specs the full `verify:pe-budget-phase-10b31` jest invocation also touches),
# runs the fast jest GREEN check, then the deeper RED/GREEN mutation-sensitivity
# check, and always removes the container on exit (success, failure, or
# interruption).
#
# Requires: docker, and apps/defense-budget-parser already `uv sync --locked`.
# Makes ZERO AWS calls and ZERO production-database calls -- see
# verify-pe-budget-phase-10b31-metadata-regression.ts's own header.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NAME="capiro-phase10b31-metadata-$RANDOM-$$"
PORT="${PHASE10B31_PG_PORT:-0}"
PASSWORD="phase10b31-rehearsal"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Starting disposable Postgres ($NAME)..." >&2
if [[ "$PORT" == "0" ]]; then
  CONTAINER_ID="$(docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -P pgvector/pgvector:pg16)"
  PORT="$(docker port "$NAME" 5432/tcp | head -1 | cut -d: -f2)"
else
  docker run -d --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=capiro -p "$PORT:5432" pgvector/pgvector:pg16 >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null

export DATABASE_URL="postgresql://postgres:${PASSWORD}@localhost:${PORT}/capiro"
echo "Postgres ready at localhost:${PORT}. Applying migrations..." >&2

npx prisma migrate deploy >/dev/null
npx prisma migrate deploy --schema prisma/phase6-projection/schema.prisma >/dev/null

echo "Running the fast GREEN check (current, fixed source)..." >&2
npx jest --runInBand --forceExit src/defense-budget/verification/persistence/lifecycle-bridge-source-metadata-agreement.integration.spec.ts

echo "Running the deeper RED/GREEN mutation-sensitivity check..." >&2
npx tsx scripts/verify-pe-budget-phase-10b31-metadata-regression.ts
