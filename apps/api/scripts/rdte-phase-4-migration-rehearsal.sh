#!/usr/bin/env bash
#
# Phase 4 WS N — disposable PostgreSQL migration rehearsal (plan §19).
#
# Rehearses the ONE Phase 4 migration (20260817010000_rdte_phase4_projection_schema)
# on a throwaway docker PostgreSQL — NEVER against a shared database.
#
# Paths:
#   A) Fresh apply:  prisma migrate deploy (all migrations incl. Phase 4) on an
#      empty database; asserts the new tables/constraints exist.
#   B) Upgrade path: apply every migration EXCEPT the Phase 4 one (pre-Phase-4
#      schema), seed representative rows, apply the Phase 4 SQL, then assert:
#        - existing program_element_project rows preserved;
#        - project_code widening preserved (no truncation; 32-char code fits);
#        - valid project position accepted;
#        - duplicate natural key rejected;
#        - invalid quarter rejected;
#        - fake period/date combination rejected.
#
# Usage (from repo root):
#   bash apps/api/scripts/rdte-phase-4-migration-rehearsal.sh
#
# Env:
#   P4_REHEARSAL_PG_IMAGE   default pgvector/pgvector:pg16
#   P4_REHEARSAL_PG_PORT    default 55441
#   P4_REHEARSAL_KEEP       if 1, leave container running
#
set -euo pipefail

to_win_path() {
  local p="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$p" 2>/dev/null && return 0
  fi
  if [[ "$p" =~ ^/([a-zA-Z])/(.*)$ ]]; then
    local drive="${BASH_REMATCH[1]}"
    local rest="${BASH_REMATCH[2]}"
    drive="$(echo "$drive" | tr 'a-z' 'A-Z')"
    echo "${drive}:/${rest}"
    return 0
  fi
  echo "$p"
}

SCRIPT_DIR="$(cd "$(dirname "$(to_win_path "${BASH_SOURCE[0]}")")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$API_ROOT/../.." && pwd)"

IMAGE="${P4_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P4_REHEARSAL_PG_PORT:-55441}"
NAME="pe-p4-mig-rehearsal"
USER_NAME="postgres"
PASSWORD="postgres"
MIGRATIONS_DIR="$API_ROOT/prisma/migrations"
P4_MIGRATION="20260817010000_rdte_phase4_projection_schema"

log() { echo "[p4-rehearsal] $*"; }
fail() { echo "[p4-rehearsal] FAILED: $*" >&2; exit 1; }

PSQL=(docker exec -i "$NAME" psql -U "$USER_NAME" -d capiro -v ON_ERROR_STOP=1 -q)

cleanup() {
  if [ "${P4_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  else
    log "P4_REHEARSAL_KEEP=1 — container '$NAME' left running on port $PORT"
  fi
}

# ── Start disposable container ──────────────────────────────────────────────
docker rm -f "$NAME" >/dev/null 2>&1 || true
log "starting disposable $IMAGE on port $PORT"
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER_NAME" \
  -e POSTGRES_PASSWORD="***" \
  -e POSTGRES_DB=capiro \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

trap cleanup EXIT

log "waiting for postgres readiness"
for i in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U "$USER_NAME" -d capiro >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$NAME" pg_isready -U "$USER_NAME" -d capiro >/dev/null 2>&1 \
  || fail "postgres did not become ready"

PG_VERSION="$("${PSQL[@]}" -tAc 'SELECT version();' | head -1)"
log "PostgreSQL: $PG_VERSION"

# ── Path A: fresh apply (empty DB -> tip) ───────────────────────────────────
log "Path A: fresh prisma migrate deploy on empty database"
(cd "$API_ROOT" && DATABASE_URL="postgresql://$USER_NAME:***@$HOSTNAME:$PORT/capiro" \
  npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)
log "Path A: deploy succeeded"

"${PSQL[@]}" -tAc "SELECT to_regclass('public.program_element_project_budget_position');" \
  | grep -q program_element_project_budget_position \
  || fail "Path A: project budget position table missing"
"${PSQL[@]}" -tAc "SELECT to_regclass('public.program_element_milestone_schedule_period');" \
  | grep -q program_element_milestone_schedule_period \
  || fail "Path A: milestone schedule period table missing"

COL_WIDTH="$("${PSQL[@]}" -tAc "SELECT character_maximum_length FROM information_schema.columns WHERE table_name='program_element_project' AND column_name='project_code';")"
[ "$COL_WIDTH" = "32" ] || fail "Path A: project_code width is $COL_WIDTH, expected 32"
log "Path A: fresh apply OK (tables + VarChar(32) verified)"

# ── Path B: upgrade from pre-Phase-4 schema ─────────────────────────────────
# Replays every migration EXCEPT the Phase 4 one with prisma's own deploy
# engine against a second database in the same disposable container, then
# applies the Phase 4 SQL and checks upgrade behavior.
log "Path B: recreating database capiro for the pre-Phase-4 replay"
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS capiro;" -c "CREATE DATABASE capiro;" >/dev/null

# Stage migrations WITHOUT the Phase 4 one in a repo-local directory and
# address the schema RELATIVELY from $API_ROOT — prisma on Windows cannot
# read MSYS-converted absolute /c/... paths. Early migrations hardcode
# database name 'capiro' (GRANT CONNECT ON DATABASE capiro), so the
# rehearsal DB must be named capiro.
TMP_MIG_REL=".p4-rehearsal-migrations"
rm -rf "$API_ROOT/$TMP_MIG_REL"
mkdir -p "$API_ROOT/$TMP_MIG_REL/migrations"
cp "$API_ROOT/prisma/schema.prisma" "$API_ROOT/$TMP_MIG_REL/schema.prisma"
cp "$MIGRATIONS_DIR/migration_lock.toml" "$API_ROOT/$TMP_MIG_REL/migrations/" 2>/dev/null || true
COPIED=0
for dir in "$MIGRATIONS_DIR"/*/; do
  mig="$(basename "$dir")"
  if [ "$mig" = "$P4_MIGRATION" ]; then continue; fi
  cp -r "$dir" "$API_ROOT/$TMP_MIG_REL/migrations/"
  COPIED=$((COPIED + 1))
done
log "Path B: $COPIED pre-Phase-4 migrations staged"

export DATABASE_URL="postgresql://$USER_NAME:***@localhost:$PORT/capiro"
DEPLOY_LOG="$(mktemp -t p4-deploy-XXXXXX.log 2>/dev/null || echo /tmp/p4-deploy.log)"
if ! (cd "$API_ROOT" && npx prisma migrate deploy --schema "$TMP_MIG_REL/schema.prisma" >"$DEPLOY_LOG" 2>&1); then
  tail -30 "$DEPLOY_LOG" >&2
  fail "Path B: pre-Phase-4 replay failed (log: $DEPLOY_LOG)"
fi
rm -rf "$API_ROOT/$TMP_MIG_REL"

PSQL_B=(docker exec -i "$NAME" psql -U "$USER_NAME" -d capiro -v ON_ERROR_STOP=1 -q)

# Seed representative existing rows (pre-Phase-4 state).
"${PSQL_B[@]}" <<'SQL' >/dev/null
INSERT INTO program_element (pe_code, title, source)
VALUES ('0601101A', 'Advanced Technology Development', 'rehearsal');
INSERT INTO program_element_project (pe_code, project_code, title, source, updated_at)
VALUES ('0601101A', 'AB-12.34', 'Existing Project', 'rehearsal', now()),
       ('0601101A', 'A1', 'Short Project', 'rehearsal', now());
SQL

# Apply the Phase 4 migration (the exact SQL under rehearsal).
log "Path B: applying Phase 4 migration on pre-Phase-4 schema"
docker exec -i "$NAME" psql -U "$USER_NAME" -d capiro -v ON_ERROR_STOP=1 -q \
  < "$MIGRATIONS_DIR/$P4_MIGRATION/migration.sql" >/dev/null \
  || fail "Path B: Phase 4 migration failed on upgrade path"

# B1: existing project rows preserved, no truncation.
ROWS="$("${PSQL_B[@]}" -tAc "SELECT count(*) FROM program_element_project WHERE pe_code='0601101A';")"
[ "$ROWS" = "2" ] || fail "Path B: existing project rows lost ($ROWS)"
KEPT="$("${PSQL_B[@]}" -tAc "SELECT project_code FROM program_element_project WHERE title='Existing Project';")"
[ "$KEPT" = "AB-12.34" ] || fail "Path B: project code truncated ($KEPT)"
log "Path B: existing rows preserved, widening preserved"

# B2: a 32-char project code now fits (source-faithful width).
"${PSQL_B[@]}" -c "INSERT INTO program_element_project (pe_code, project_code, title, source, updated_at) VALUES ('0601101A', 'AB-12.34-XY.56-Z9-LONG-CODE-01', 'Long Project', 'rehearsal', now());" >/dev/null \
  || fail "Path B: 32-char project code rejected after widening"
log "Path B: 32-char project code accepted"

# B3: valid project position accepted.
"${PSQL_B[@]}" -c "INSERT INTO program_element_project_budget_position (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind) VALUES ('0601101A', 'A1', 'pb_fy2027', 2027, 7.00, 'total');" >/dev/null \
  || fail "Path B: valid project position rejected"
log "Path B: valid project position accepted"

# B4: duplicate natural key rejected.
if "${PSQL_B[@]}" -c "INSERT INTO program_element_project_budget_position (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind) VALUES ('0601101A', 'A1', 'pb_fy2027', 2027, 9.00, 'total');" >/dev/null 2>&1; then
  fail "Path B: duplicate natural key was accepted"
fi
log "Path B: duplicate natural key rejected"

# B5: invalid quarter rejected.
"${PSQL_B[@]}" -c "INSERT INTO program_element_milestone (id, pe_code, milestone_type, source) VALUES (gen_random_uuid(), '0601101A', 'CDR', 'rehearsal');" >/dev/null
MID="$("${PSQL_B[@]}" -tAc "SELECT id FROM program_element_milestone WHERE milestone_type='CDR';")"
if "${PSQL_B[@]}" -c "INSERT INTO program_element_milestone_schedule_period (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind, fiscal_quarter) VALUES ('$MID', '0601101A', 'CDR', 'planned', '5Q FY2028', 'fiscal_quarter', 5);" >/dev/null 2>&1; then
  fail "Path B: invalid quarter (5) was accepted"
fi
log "Path B: invalid quarter rejected"

# B6: fake period/date combination rejected (fiscal_quarter + exact_date).
if "${PSQL_B[@]}" -c "INSERT INTO program_element_milestone_schedule_period (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind, exact_date) VALUES ('$MID', '0601101A', 'CDR', 'planned', '3Q FY2028', 'fiscal_quarter', '2028-01-01');" >/dev/null 2>&1; then
  fail "Path B: fake period/date combination was accepted"
fi
log "Path B: fake period/date combination rejected"

# B7: a truthful fiscal-quarter period IS accepted (positive control).
"${PSQL_B[@]}" -c "INSERT INTO program_element_milestone_schedule_period (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind, fiscal_year, fiscal_quarter) VALUES ('$MID', '0601101A', 'CDR', 'planned', '3Q FY2028', 'fiscal_quarter', 2028, 3);" >/dev/null \
  || fail "Path B: truthful fiscal-quarter period rejected"
log "Path B: truthful period accepted"

log "REHEARSAL PASSED — no shared database touched; rollback = drop the disposable container (or drop the two new tables + restore column types)."
exit 0
