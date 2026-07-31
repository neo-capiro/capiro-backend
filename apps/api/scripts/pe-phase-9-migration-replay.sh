#!/usr/bin/env bash
#
# Phase 9 disposable PostgreSQL clean + production-equivalent upgrade migrate replay.
#
# Proves:
#   1) Empty DB: prisma migrate deploy → tip succeeds (clean replay)
#   2) Upgrade path: start a fresh DB, apply migrations up to origin/main's latest
#      migration directory that exists on HEAD, dump schema, recreate DB, restore
#      dump, then migrate deploy to tip (upgrade replay covering branch-only migrations)
#
# NEVER point this at a shared / staging / production database.
# Creates disposable docker container pe-phase9-mig (or uses PE_PHASE_9_* overrides).
#
# Usage (from repo root):
#   bash apps/api/scripts/pe-phase-9-migration-replay.sh
#
# Env:
#   PE_PHASE_9_PG_IMAGE   default pgvector/pgvector:pg16
#   PE_PHASE_9_PG_PORT    default 55439
#   PE_PHASE_9_KEEP       if 1, leave container running
#   DATABASE_URL          overridden internally for the disposable instance
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

IMAGE="${PE_PHASE_9_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${PE_PHASE_9_PG_PORT:-55439}"
NAME="${PE_PHASE_9_PG_NAME:-pe-phase9-mig}"
USER_NAME=capiro
PASS=capiro
# Several migrations (e.g. 20260502020000_capiro_app_role) reference database "capiro" by name.
# The disposable instance MUST expose a real DB named capiro (same as docker-compose / Phase 8).
DB_CLEAN=capiro
DB_UPGRADE=pe_phase9_upgrade
KEEP="${PE_PHASE_9_KEEP:-0}"

API="$ROOT/apps/api"
MIG_DIR="$API/prisma/migrations"

if ! command -v docker >/dev/null 2>&1; then
  echo "FATAL: docker not on PATH (disposable Postgres required)" >&2
  exit 75
fi

if ! docker info >/dev/null 2>&1; then
  echo "FATAL: docker daemon not reachable" >&2
  exit 75
fi

cleanup() {
  if [ "$KEEP" = "1" ]; then
    echo "KEEP=1 — leaving container $NAME"
    return 0
  fi
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== Phase 9 migration replay image=$IMAGE port=$PORT =="

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER_NAME" \
  -e POSTGRES_PASSWORD="$PASS" \
  -e POSTGRES_DB=capiro \
  -p "${PORT}:5432" \
  "$IMAGE" >/dev/null

echo "Waiting for postgres..."
for i in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U "$USER_NAME" -d capiro >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [ "$i" -eq 60 ]; then
    echo "FATAL: postgres did not become ready" >&2
    exit 1
  fi
done

psql_d() {
  local db="$1"; shift
  docker exec -e PGPASSWORD="$PASS" "$NAME" \
    psql -U "$USER_NAME" -d "$db" -v ON_ERROR_STOP=1 "$@"
}

# MSYS/Git Bash paths like /c/c/Users/... must become C:/c/Users/... for win32 node.exe
to_win_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p"
    return 0
  fi
  # Manual: /x/rest -> X:/rest
  if [[ "$p" =~ ^/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]}"
    # uppercase drive
    drive="$(echo "$drive" | tr 'a-z' 'A-Z')"
    echo "${drive}:/${rest}"
    return 0
  fi
  echo "$p"
}

# Resolve node + prisma entry without broken Windows/MSYS pnpm shims.
# Prefer PE_PHASE_9_NODE / known Hermes node, then `node` on PATH.
resolve_node() {
  if [ -n "${PE_PHASE_9_NODE:-}" ] && [ -x "${PE_PHASE_9_NODE}" ]; then
    echo "${PE_PHASE_9_NODE}"
    return 0
  fi
  if [ -x "C:/Users/neoma/AppData/Local/hermes/node/node.exe" ]; then
    echo "C:/Users/neoma/AppData/Local/hermes/node/node.exe"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  echo ""
  return 1
}

resolve_prisma_js() {
  if [ -f "$API/node_modules/prisma/build/index.js" ]; then
    to_win_path "$API/node_modules/prisma/build/index.js"
    return 0
  fi
  if [ -f "$ROOT/node_modules/prisma/build/index.js" ]; then
    to_win_path "$ROOT/node_modules/prisma/build/index.js"
    return 0
  fi
  # pnpm virtual store (best-effort)
  local hit
  hit="$(ls -1d "$ROOT"/node_modules/.pnpm/prisma@*/node_modules/prisma/build/index.js 2>/dev/null | head -1 || true)"
  if [ -n "$hit" ] && [ -f "$hit" ]; then
    to_win_path "$hit"
    return 0
  fi
  echo ""
  return 1
}

NODE_BIN="$(resolve_node || true)"
PRISMA_JS="$(resolve_prisma_js || true)"
if [ -z "$NODE_BIN" ] || [ -z "$PRISMA_JS" ]; then
  echo "FATAL: cannot locate node ($NODE_BIN) or prisma js ($PRISMA_JS)" >&2
  exit 1
fi
echo "using_node=$NODE_BIN"
echo "using_prisma_js=$PRISMA_JS"

run_migrate() {
  local url="$1"
  local api_win
  api_win="$(to_win_path "$API")"
  (
    cd "$API" || exit 1
    # Direct node + prisma build entry — win32 paths only for node.exe argv.
    DATABASE_URL="$url" "$NODE_BIN" "$PRISMA_JS" migrate deploy
  )
}

url_for() {
  local db="$1"
  echo "postgresql://${USER_NAME}:${PASS}@127.0.0.1:${PORT}/${db}?schema=public"
}

# ── 1) Clean replay ──────────────────────────────────────────────────────────
echo "-- clean replay DB=$DB_CLEAN"
# End any sessions and rebuild empty capiro DB
psql_d postgres -qAtc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_CLEAN}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql_d postgres -qAtc "DROP DATABASE IF EXISTS \"${DB_CLEAN}\";"
psql_d postgres -qAtc "CREATE DATABASE \"${DB_CLEAN}\" OWNER \"${USER_NAME}\";"

CLEAN_URL="$(url_for "$DB_CLEAN")"
set +e
run_migrate "$CLEAN_URL"
CLEAN_CODE=$?
set -e
echo "clean_migrate_exit=$CLEAN_CODE"
if [ "$CLEAN_CODE" -ne 0 ]; then
  echo "FATAL: clean migrate replay failed" >&2
  exit "$CLEAN_CODE"
fi

# Count applied migrations
APPLIED_CLEAN="$(psql_d "$DB_CLEAN" -qAtc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
echo "clean_applied_migrations=$APPLIED_CLEAN"
if [ -z "$APPLIED_CLEAN" ] || [ "$APPLIED_CLEAN" -lt 1 ]; then
  echo "FATAL: expected applied migrations on clean DB" >&2
  exit 1
fi

# ── 2) Upgrade replay ────────────────────────────────────────────────────────
# Identify branch-only migration directories vs origin/main (added files only).
BRANCH_ONLY_FILE="$(mktemp)"
# Prefer git diff name-status: A = added on our side of main...HEAD
git -C "$ROOT" diff --name-only --diff-filter=A origin/main...HEAD -- apps/api/prisma/migrations \
  2>/dev/null \
  | sed -n 's#^apps/api/prisma/migrations/\([^/]*\)/migration.sql$#\1#p' \
  | sort -u >"$BRANCH_ONLY_FILE" || true
# Fallback: set difference of directory names if diff empty but trees differ
if [ ! -s "$BRANCH_ONLY_FILE" ]; then
  MAIN_LIST="$(mktemp)"
  HEAD_LIST="$(mktemp)"
  git -C "$ROOT" ls-tree -r --name-only origin/main 2>/dev/null \
    | grep '^apps/api/prisma/migrations/.*/migration.sql$' \
    | sed -n 's#apps/api/prisma/migrations/\([^/]*\)/migration.sql#\1#p' \
    | sort -u >"$MAIN_LIST" || true
  ls -1 "$MIG_DIR" 2>/dev/null | grep -v migration_lock.toml | sort >"$HEAD_LIST" || true
  if [ -s "$MAIN_LIST" ]; then
    comm -13 "$MAIN_LIST" "$HEAD_LIST" >"$BRANCH_ONLY_FILE" || true
  fi
  rm -f "$MAIN_LIST" "$HEAD_LIST"
fi
BRANCH_ONLY_COUNT="$(grep -c . "$BRANCH_ONLY_FILE" 2>/dev/null || echo 0)"
# normalize count
BRANCH_ONLY_COUNT="$(echo "$BRANCH_ONLY_COUNT" | tr -d '[:space:]')"
echo "branch_only_migrations=$BRANCH_ONLY_COUNT"
if [ "${BRANCH_ONLY_COUNT:-0}" -gt 0 ]; then
  echo "branch-only:"
  sed 's/^/  /' "$BRANCH_ONLY_FILE"
fi

echo "-- upgrade replay DB=$DB_UPGRADE"
psql_d postgres -qAtc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_UPGRADE}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql_d postgres -qAtc "DROP DATABASE IF EXISTS \"${DB_UPGRADE}\";"
psql_d postgres -qAtc "CREATE DATABASE \"${DB_UPGRADE}\" OWNER \"${USER_NAME}\";"
UP_URL="$(url_for "$DB_UPGRADE")"

# Strategy:
#  - Move branch-only migrations aside
#  - migrate deploy → base (main-equivalent) schema
#  - pg_dump/pg_restore entirely inside the container (/tmp) to avoid MSYS path doubling
#  - restore branch-only migrations
#  - migrate deploy → tip
ASIDE_HOST="${TMPDIR:-/tmp}/pe-phase9-mig-aside-$$"
rm -rf "$ASIDE_HOST"
mkdir -p "$ASIDE_HOST"

if [ "${BRANCH_ONLY_COUNT:-0}" -gt 0 ]; then
  while IFS= read -r mig || [ -n "$mig" ]; do
    [ -z "$mig" ] && continue
    if [ -d "$MIG_DIR/$mig" ]; then
      mv "$MIG_DIR/$mig" "$ASIDE_HOST/$mig"
    fi
  done <"$BRANCH_ONLY_FILE"
fi

restore_branch_migs() {
  if [ -d "$ASIDE_HOST" ]; then
    for d in "$ASIDE_HOST"/*; do
      [ -e "$d" ] || continue
      base="$(basename "$d")"
      if [ ! -d "$MIG_DIR/$base" ]; then
        mv "$d" "$MIG_DIR/$base"
      fi
    done
  fi
}
trap 'restore_branch_migs; cleanup' EXIT

set +e
run_migrate "$UP_URL"
BASE_CODE=$?
set -e
echo "upgrade_base_migrate_exit=$BASE_CODE"
if [ "$BASE_CODE" -ne 0 ]; then
  echo "FATAL: base (main-equivalent) migrate failed" >&2
  restore_branch_migs
  exit "$BASE_CODE"
fi

BASE_APPLIED="$(psql_d "$DB_UPGRADE" -qAtc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
echo "upgrade_base_applied=$BASE_APPLIED"
if [ -z "$BASE_APPLIED" ] || [ "$BASE_APPLIED" -lt 1 ]; then
  echo "FATAL: base upgrade DB has no applied migrations (branch-only aside logic may have hidden main migrations)" >&2
  restore_branch_migs
  exit 1
fi

# Dump + restore inside container only
docker exec -e PGPASSWORD="$PASS" "$NAME" \
  pg_dump -U "$USER_NAME" -d "$DB_UPGRADE" -Fc -f /tmp/pe_phase9_base.dump

psql_d postgres -qAtc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DB_UPGRADE}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql_d postgres -qAtc "DROP DATABASE IF EXISTS \"${DB_UPGRADE}\";"
psql_d postgres -qAtc "CREATE DATABASE \"${DB_UPGRADE}\" OWNER \"${USER_NAME}\";"
docker exec -e PGPASSWORD="$PASS" "$NAME" \
  pg_restore -U "$USER_NAME" -d "$DB_UPGRADE" --no-owner --no-acl /tmp/pe_phase9_base.dump \
  >/tmp/pe-phase9-pg_restore.log 2>&1 || true

HAS_TABLE="$(psql_d "$DB_UPGRADE" -qAtc "SELECT to_regclass('_prisma_migrations') IS NOT NULL;" | tr -d '[:space:]')"
if [ "$HAS_TABLE" != "t" ] && [ "$HAS_TABLE" != "true" ]; then
  echo "FATAL: restore did not produce _prisma_migrations" >&2
  cat /tmp/pe-phase9-pg_restore.log 2>/dev/null || true
  restore_branch_migs
  exit 1
fi

restore_branch_migs
trap cleanup EXIT

set +e
run_migrate "$UP_URL"
UP_CODE=$?
set -e
echo "upgrade_tip_migrate_exit=$UP_CODE"
if [ "$UP_CODE" -ne 0 ]; then
  echo "FATAL: upgrade migrate to tip failed" >&2
  exit "$UP_CODE"
fi

TIP_APPLIED="$(psql_d "$DB_UPGRADE" -qAtc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
echo "upgrade_tip_applied=$TIP_APPLIED"

if [ "$TIP_APPLIED" -lt "$APPLIED_CLEAN" ]; then
  echo "FATAL: upgrade tip applied ($TIP_APPLIED) < clean applied ($APPLIED_CLEAN)" >&2
  exit 1
fi

# Drift check: clean and upgrade tip should have same migration names set
CLEAN_NAMES="$(psql_d "$DB_CLEAN" -qAtc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" | tr -d '\r')"
UP_NAMES="$(psql_d "$DB_UPGRADE" -qAtc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" | tr -d '\r')"
if [ "$CLEAN_NAMES" != "$UP_NAMES" ]; then
  echo "FATAL: migration name set drift between clean and upgrade tip" >&2
  echo "--- clean ---"; echo "$CLEAN_NAMES"
  echo "--- upgrade ---"; echo "$UP_NAMES"
  exit 1
fi

rm -f "$BRANCH_ONLY_FILE"
rm -rf "$ASIDE_HOST"

echo "PE_PHASE_9_MIGRATION_REPLAY_OK clean_exit=$CLEAN_CODE upgrade_exit=$UP_CODE applied=$TIP_APPLIED"
exit 0
