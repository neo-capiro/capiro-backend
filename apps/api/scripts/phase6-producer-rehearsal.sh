#!/usr/bin/env bash
# Gap 1 closeout — disposable PostgreSQL rehearsal for the Phase 6 producer
# chain (builder -> repository -> committee projection source).
#
# Applies only the phase6-projection schema's own migrations to a fresh
# disposable database, then runs phase6-producer-rehearsal.ts against it
# through the real @prisma/client. NEVER connects to a shared database. The
# container is destroyed on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATION_ROOT="$API_ROOT/prisma/phase6-projection/migrations"
mapfile -t MIGRATIONS < <(find "$MIGRATION_ROOT" -mindepth 2 -maxdepth 2 -name migration.sql -print | sort)
if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  echo "no Phase 6 projection migrations found" >&2
  exit 1
fi

NAME="capiro-p6-producer-$RANDOM-$$"
PASSWORD="p6-producer-rehearsal"
PORT="${P6_PRODUCER_REHEARSAL_PG_PORT:-55448}"
DB_NAME="p6_producer_rehearsal"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -p "$PORT:5432" -e POSTGRES_PASSWORD="$PASSWORD" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null

docker exec "$NAME" createdb -U postgres "$DB_NAME"
for migration in "${MIGRATIONS[@]}"; do
  docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" < "$migration" >/dev/null
done

export DATABASE_URL="postgresql://postgres:$PASSWORD@localhost:$PORT/$DB_NAME"

cd "$API_ROOT"
# Relative path after cd — MSYS absolute paths like /c/Users/... become
# C:\c\Users\... under native Windows Node/tsx and fail to resolve.
npx tsx ./scripts/phase6-producer-rehearsal.ts
