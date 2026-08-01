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

# ── Path helpers (MSYS / doubled /c/c worktrees) ─────────────────────────────
# bash `pwd` can return /c/c/Users/... which Git for Windows does not accept via
# `git -C`. Prefer a Windows-mixed path Git can open (pwd -W / cygpath -m).

to_win_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p" 2>/dev/null && return 0
  fi
  # Manual: /x/rest -> X:/rest (single-letter drive prefix only)
  if [[ "$p" =~ ^/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]}"
    drive="$(echo "$drive" | tr 'a-z' 'A-Z')"
    echo "${drive}:/${rest}"
    return 0
  fi
  echo "$p"
}

resolve_script_dir() {
  local src="${BASH_SOURCE[0]}"
  local dir
  dir="$(cd "$(dirname "$src")" && pwd)"
  # Prefer Windows path when available so absolute paths stay Git-friendly.
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$dir" 2>/dev/null && return 0
  fi
  if dir_w="$(cd "$(dirname "$src")" && pwd -W 2>/dev/null)"; then
    echo "$dir_w"
    return 0
  fi
  echo "$dir"
}

SCRIPT_DIR="$(resolve_script_dir)"
# apps/api/scripts -> repo root
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then
  ROOT="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"
elif root_w="$(cd "$SCRIPT_DIR/../../.." && pwd -W 2>/dev/null)"; then
  ROOT="$root_w"
fi
# Final normalize: never leave bare /c/... for Git/node when a win path exists.
case "$ROOT" in
  [A-Za-z]:/*|[A-Za-z]:\\*) ;;
  *)
    ROOT="$(to_win_path "$ROOT")"
    ;;
esac
cd "$ROOT" || {
  echo "FATAL: cannot cd to ROOT=$ROOT" >&2
  exit 1
}

# Git cwd must be a path `git -C` accepts (Windows Git rejects MSYS /c/c/... forms).
resolve_git_root() {
  local candidate candidates=()
  candidates+=("$ROOT")
  if command -v cygpath >/dev/null 2>&1; then
    candidates+=("$(cygpath -m "$ROOT" 2>/dev/null || true)")
    candidates+=("$(cygpath -w "$ROOT" 2>/dev/null | tr '\\' '/' || true)")
  fi
  if pwd_w="$(pwd -W 2>/dev/null)"; then
    candidates+=("$pwd_w")
  fi
  candidates+=("$(pwd)")
  candidates+=("$(to_win_path "$(pwd)")")

  local seen=""
  for candidate in "${candidates[@]}"; do
    [ -z "$candidate" ] && continue
    # de-dupe
    case " $seen " in
      *" $candidate "*) continue ;;
    esac
    seen="$seen $candidate"
    if git -C "$candidate" rev-parse --show-toplevel >/dev/null 2>&1; then
      # Prefer mixed Windows path of the resolved toplevel when possible
      local tl
      tl="$(git -C "$candidate" rev-parse --show-toplevel 2>/dev/null | tr -d '\r')"
      if command -v cygpath >/dev/null 2>&1; then
        tl="$(cygpath -m "$tl" 2>/dev/null || echo "$tl")"
      fi
      echo "$tl"
      return 0
    fi
  done
  return 1
}

GIT_ROOT="$(resolve_git_root || true)"
if [ -z "${GIT_ROOT:-}" ]; then
  echo "FATAL: cannot resolve a Git-accepted repo root (MSYS path doubling? ROOT=$ROOT pwd=$(pwd))" >&2
  exit 1
fi
echo "git_root=$GIT_ROOT"
echo "bash_root=$ROOT"

git_ok() {
  git -C "$GIT_ROOT" "$@"
}

# Fail hard on git errors — never swallow exit 128 into empty branch-only lists.
git_req() {
  local out ec
  set +e
  out="$(git -C "$GIT_ROOT" "$@" 2>&1)"
  ec=$?
  set -e
  if [ "$ec" -ne 0 ]; then
    echo "FATAL: git -C \"$GIT_ROOT\" $* failed (exit=$ec)" >&2
    echo "$out" >&2
    exit 1
  fi
  printf '%s\n' "$out"
}

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
# Keep migrations dirs on paths bash can mv; convert via to_win only for node argv.

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

# Safe line count of a file (never "00" from grep -c || echo 0).
count_lines() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo 0
    return 0
  fi
  local n
  n="$(wc -l <"$f" | tr -d '[:space:]')"
  if [ -z "$n" ]; then
    echo 0
  else
    # strip leading zeros without octal surprises
    echo "$((10#$n))"
  fi
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

# ── 2) Upgrade replay — discover branch-only migrations honestly ─────────────
BRANCH_ONLY_FILE="$(mktemp)"
MAIN_LIST="$(mktemp)"
HEAD_LIST="$(mktemp)"
DIFF_LIST="$(mktemp)"

# Prove git accepts GIT_ROOT before any silent empty list path.
git_req rev-parse --verify HEAD >/dev/null
git_req rev-parse --verify origin/main >/dev/null

# Main migration.sql count (directories on origin/main)
git_req ls-tree -r --name-only origin/main -- apps/api/prisma/migrations \
  | grep 'migration\.sql$' \
  | sed -n 's#^apps/api/prisma/migrations/\([^/]*\)/migration\.sql$#\1#p' \
  | sort -u >"$MAIN_LIST"
MAIN_MIG_COUNT="$(count_lines "$MAIN_LIST")"
echo "main_migration_dirs=$MAIN_MIG_COUNT"

# HEAD filesystem migration dirs
ls -1 "$MIG_DIR" 2>/dev/null | grep -v '^migration_lock.toml$' | sort >"$HEAD_LIST" || true
HEAD_MIG_COUNT="$(count_lines "$HEAD_LIST")"
echo "head_migration_dirs=$HEAD_MIG_COUNT"

# Preferred: git diff name-status A = added on our side of main...HEAD
set +e
git -C "$GIT_ROOT" diff --name-only --diff-filter=A origin/main...HEAD -- apps/api/prisma/migrations \
  >"$DIFF_LIST.raw" 2>"$DIFF_LIST.err"
DIFF_EC=$?
set -e
if [ "$DIFF_EC" -ne 0 ]; then
  echo "FATAL: git diff branch-only discovery failed (exit=$DIFF_EC)" >&2
  cat "$DIFF_LIST.err" >&2
  rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST" "$DIFF_LIST.raw" "$DIFF_LIST.err"
  exit 1
fi
sed -n 's#^apps/api/prisma/migrations/\([^/]*\)/migration\.sql$#\1#p' "$DIFF_LIST.raw" \
  | sort -u >"$DIFF_LIST"
rm -f "$DIFF_LIST.raw" "$DIFF_LIST.err"

if [ -s "$DIFF_LIST" ]; then
  cp "$DIFF_LIST" "$BRANCH_ONLY_FILE"
else
  # Fallback: set difference of directory names (comm -13)
  if [ ! -s "$MAIN_LIST" ] && [ "$HEAD_MIG_COUNT" -gt 0 ]; then
    echo "FATAL: origin/main migration list empty but HEAD has $HEAD_MIG_COUNT dirs (git discovery failed)" >&2
    rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
    exit 1
  fi
  comm -13 "$MAIN_LIST" "$HEAD_LIST" >"$BRANCH_ONLY_FILE" || true
fi

BRANCH_ONLY_COUNT="$(count_lines "$BRANCH_ONLY_FILE")"
# Tree delta vs name discovery
TREE_DELTA=$((HEAD_MIG_COUNT - MAIN_MIG_COUNT))
if [ "$TREE_DELTA" -lt 0 ]; then
  TREE_DELTA=0
fi

echo "branch_only_migrations=$BRANCH_ONLY_COUNT tree_delta=$TREE_DELTA"
if [ "$BRANCH_ONLY_COUNT" -gt 0 ]; then
  echo "branch-only:"
  sed 's/^/  /' "$BRANCH_ONLY_FILE"
fi

# Hard assertions: never false-green when main and HEAD migration trees differ
if [ "$BRANCH_ONLY_COUNT" -eq 0 ] && [ "$HEAD_MIG_COUNT" -ne "$MAIN_MIG_COUNT" ]; then
  echo "FATAL: branch-only list empty but main ($MAIN_MIG_COUNT) vs HEAD ($HEAD_MIG_COUNT) migration dirs differ" >&2
  echo "--- main sample ---"; head -5 "$MAIN_LIST" >&2 || true
  echo "--- head sample ---"; head -5 "$HEAD_LIST" >&2 || true
  rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
  exit 1
fi

# This PE tip expects the two PE migrations vs main (observation outbox + data issue).
# Allow PE_PHASE_9_EXPECT_BRANCH_MIGS override; default ≥2 when tree shows PE overlay.
EXPECT_MIN_BRANCH="${PE_PHASE_9_EXPECT_BRANCH_MIGS:-}"
if [ -z "$EXPECT_MIN_BRANCH" ]; then
  if [ "$TREE_DELTA" -ge 2 ]; then
    EXPECT_MIN_BRANCH=2
  else
    EXPECT_MIN_BRANCH="$TREE_DELTA"
  fi
fi
if [ "$BRANCH_ONLY_COUNT" -lt "$EXPECT_MIN_BRANCH" ]; then
  echo "FATAL: branch_only_migrations=$BRANCH_ONLY_COUNT < expected_min=$EXPECT_MIN_BRANCH (main=$MAIN_MIG_COUNT head=$HEAD_MIG_COUNT)" >&2
  rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
  exit 1
fi

# Optional exact-name checks when defaults known on tip
if [ "${PE_PHASE_9_STRICT_PE_MIG_NAMES:-1}" = "1" ] && [ "$EXPECT_MIN_BRANCH" -ge 2 ]; then
  for need in \
    20260729050000_pe_observation_idempotency_and_outbox \
    20260811010000_program_element_data_issue
  do
    if ! grep -qxF "$need" "$BRANCH_ONLY_FILE"; then
      # Only require when the dir exists on HEAD (older tips may differ)
      if [ -d "$MIG_DIR/$need" ]; then
        echo "FATAL: expected PE branch-only migration missing from discovery: $need" >&2
        sed 's/^/  /' "$BRANCH_ONLY_FILE" >&2
        rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
        exit 1
      fi
    fi
  done
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

MOVED_ASIDE=0
if [ "$BRANCH_ONLY_COUNT" -gt 0 ]; then
  while IFS= read -r mig || [ -n "$mig" ]; do
    [ -z "$mig" ] && continue
    if [ -d "$MIG_DIR/$mig" ]; then
      mv "$MIG_DIR/$mig" "$ASIDE_HOST/$mig"
      MOVED_ASIDE=$((MOVED_ASIDE + 1))
    else
      echo "FATAL: branch-only migration dir not found on disk: $MIG_DIR/$mig" >&2
      # restore what we moved already
      for d in "$ASIDE_HOST"/*; do
        [ -e "$d" ] || continue
        mv "$d" "$MIG_DIR/$(basename "$d")" 2>/dev/null || true
      done
      rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
      exit 1
    fi
  done <"$BRANCH_ONLY_FILE"
fi
echo "branch_only_moved_aside=$MOVED_ASIDE"
if [ "$MOVED_ASIDE" -ne "$BRANCH_ONLY_COUNT" ]; then
  echo "FATAL: moved_aside=$MOVED_ASIDE != branch_only_count=$BRANCH_ONLY_COUNT" >&2
  for d in "$ASIDE_HOST"/*; do
    [ -e "$d" ] || continue
    mv "$d" "$MIG_DIR/$(basename "$d")" 2>/dev/null || true
  done
  rm -f "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
  exit 1
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

# Base must match main migration count, not tip (false green if aside skipped)
if [ "$BASE_APPLIED" -ne "$MAIN_MIG_COUNT" ]; then
  echo "FATAL: upgrade_base_applied=$BASE_APPLIED != main_migration_dirs=$MAIN_MIG_COUNT (aside likely failed; tip count would be $HEAD_MIG_COUNT)" >&2
  restore_branch_migs
  exit 1
fi
if [ "$BASE_APPLIED" -eq "$APPLIED_CLEAN" ] && [ "$BRANCH_ONLY_COUNT" -gt 0 ]; then
  echo "FATAL: upgrade base applied tip-equivalent count ($BASE_APPLIED) while branch_only=$BRANCH_ONLY_COUNT — aside did not take effect" >&2
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

PRE_TIP_APPLIED="$(psql_d "$DB_UPGRADE" -qAtc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
echo "upgrade_pre_tip_applied=$PRE_TIP_APPLIED"

restore_branch_migs
trap cleanup EXIT

# Capture deploy output — tip stage must apply pending PE migs (not "No pending")
TIP_LOG="$(mktemp)"
set +e
run_migrate "$UP_URL" >"$TIP_LOG" 2>&1
UP_CODE=$?
set -e
cat "$TIP_LOG"
echo "upgrade_tip_migrate_exit=$UP_CODE"
if [ "$UP_CODE" -ne 0 ]; then
  echo "FATAL: upgrade migrate to tip failed" >&2
  rm -f "$TIP_LOG"
  exit "$UP_CODE"
fi

TIP_APPLIED="$(psql_d "$DB_UPGRADE" -qAtc "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" | tr -d '[:space:]')"
echo "upgrade_tip_applied=$TIP_APPLIED"
APPLIED_DELTA=$((TIP_APPLIED - PRE_TIP_APPLIED))
echo "upgrade_tip_applied_delta=$APPLIED_DELTA"

if [ "$TIP_APPLIED" -lt "$APPLIED_CLEAN" ]; then
  echo "FATAL: upgrade tip applied ($TIP_APPLIED) < clean applied ($APPLIED_CLEAN)" >&2
  rm -f "$TIP_LOG"
  exit 1
fi

if [ "$BRANCH_ONLY_COUNT" -gt 0 ]; then
  if [ "$APPLIED_DELTA" -lt "$BRANCH_ONLY_COUNT" ]; then
    echo "FATAL: tip stage applied_delta=$APPLIED_DELTA < branch_only=$BRANCH_ONLY_COUNT (expected pending PE migs; false green if base was already tip)" >&2
    echo "--- tip migrate log ---"
    cat "$TIP_LOG" >&2 || true
    rm -f "$TIP_LOG"
    exit 1
  fi
  # Reject pure "No pending migrations" when PE overlay exists
  if grep -qiE 'No pending migrations to apply' "$TIP_LOG" && [ "$APPLIED_DELTA" -eq 0 ]; then
    echo "FATAL: tip migrate reported No pending migrations while branch_only=$BRANCH_ONLY_COUNT" >&2
    rm -f "$TIP_LOG"
    exit 1
  fi
fi

# Drift check: clean and upgrade tip should have same migration names set
CLEAN_NAMES="$(psql_d "$DB_CLEAN" -qAtc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" | tr -d '\r')"
UP_NAMES="$(psql_d "$DB_UPGRADE" -qAtc "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;" | tr -d '\r')"
if [ "$CLEAN_NAMES" != "$UP_NAMES" ]; then
  echo "FATAL: migration name set drift between clean and upgrade tip" >&2
  echo "--- clean ---"; echo "$CLEAN_NAMES"
  echo "--- upgrade ---"; echo "$UP_NAMES"
  rm -f "$TIP_LOG" "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
  exit 1
fi

rm -f "$TIP_LOG" "$BRANCH_ONLY_FILE" "$MAIN_LIST" "$HEAD_LIST" "$DIFF_LIST"
rm -rf "$ASIDE_HOST"

echo "PE_PHASE_9_MIGRATION_REPLAY_OK clean_exit=$CLEAN_CODE upgrade_exit=$UP_CODE applied=$TIP_APPLIED base_applied=$BASE_APPLIED branch_only=$BRANCH_ONLY_COUNT tip_delta=$APPLIED_DELTA"
exit 0
