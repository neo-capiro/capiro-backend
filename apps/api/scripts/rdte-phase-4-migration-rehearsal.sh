#!/usr/bin/env bash
#
# Disposable PostgreSQL 16 rehearsal for both Phase 4 migrations.
# Never connects to a shared database.
#
# Path A: empty database -> complete migration history.
# Path B: pre-Phase-4 history -> seed old rows -> apply the original Phase 4
# migration -> apply the closeout constraint migration -> positive/negative
# integrity probes.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$API_ROOT/prisma/migrations"
IMAGE="${P4_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P4_REHEARSAL_PG_PORT:-55441}"
NAME="pe-p4-mig-rehearsal"
USER_NAME="postgres"
PASSWORD="postgres"
DB_NAME="capiro"
P4_BASE="20260817010000_rdte_phase4_projection_schema"
P4_CLOSEOUT="20260818010000_rdte_phase4_closeout_constraints"

log() { echo "[p4-rehearsal] $*"; }
fail() { echo "[p4-rehearsal] FAILED: $*" >&2; exit 1; }

cleanup() {
  rm -rf "$API_ROOT/.p4-rehearsal-migrations" >/dev/null 2>&1 || true
  if [ "${P4_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  else
    log "container '$NAME' retained on port $PORT"
  fi
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
log "starting disposable $IMAGE"
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER_NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1 \
  || fail "PostgreSQL did not become ready"

PSQL=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)
export DATABASE_URL="postgresql://$USER_NAME:$PASSWORD@localhost:$PORT/$DB_NAME"

# ── Path A: fresh database to tip ───────────────────────────────────────────
log "Path A: applying complete migration history"
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)

for table in program_element_project_budget_position program_element_milestone_schedule_period; do
  "${PSQL[@]}" -tAc "SELECT to_regclass('public.$table');" | grep -q "$table" \
    || fail "Path A: $table is missing"
done

for constraint in \
  program_element_project_budget_position_project_fkey \
  program_element_project_budget_position_provenance_check \
  program_element_milestone_schedule_period_shape_check \
  program_element_milestone_schedule_period_provenance_check; do
  "${PSQL[@]}" -tAc "SELECT conname FROM pg_constraint WHERE conname='$constraint';" \
    | grep -q "$constraint" || fail "Path A: constraint $constraint is missing"
done

COL_WIDTH="$("${PSQL[@]}" -tAc "SELECT character_maximum_length FROM information_schema.columns WHERE table_name='program_element_project' AND column_name='project_code';")"
[ "$COL_WIDTH" = "32" ] || fail "Path A: project_code width is $COL_WIDTH, expected 32"
log "Path A passed"

# ── Path B: pre-Phase-4 upgrade ─────────────────────────────────────────────
log "Path B: recreating disposable database"
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;" >/dev/null

TMP_REL=".p4-rehearsal-migrations"
mkdir -p "$API_ROOT/$TMP_REL/migrations"
cp "$API_ROOT/prisma/schema.prisma" "$API_ROOT/$TMP_REL/schema.prisma"
cp "$MIGRATIONS_DIR/migration_lock.toml" "$API_ROOT/$TMP_REL/migrations/" 2>/dev/null || true
for dir in "$MIGRATIONS_DIR"/*/; do
  migration="$(basename "$dir")"
  if [ "$migration" = "$P4_BASE" ] || [ "$migration" = "$P4_CLOSEOUT" ]; then
    continue
  fi
  cp -r "$dir" "$API_ROOT/$TMP_REL/migrations/"
done

(cd "$API_ROOT" && npx prisma migrate deploy --schema "$TMP_REL/schema.prisma" >/dev/null) \
  || fail "Path B: pre-Phase-4 migration replay failed"

PSQL_B=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)
"${PSQL_B[@]}" <<'SQL' >/dev/null
INSERT INTO program_element (pe_code, title, source)
VALUES ('0601101A', 'Advanced Technology Development', 'rehearsal');
INSERT INTO program_element_project (pe_code, project_code, title, source, updated_at)
VALUES ('0601101A', 'AB-12.34', 'Existing Project', 'rehearsal', now()),
       ('0601101A', 'A1', 'Short Project', 'rehearsal', now());
SQL

log "Path B: applying original Phase 4 migration"
"${PSQL_B[@]}" < "$MIGRATIONS_DIR/$P4_BASE/migration.sql" >/dev/null \
  || fail "Path B: original Phase 4 migration failed"
log "Path B: applying closeout constraint migration"
"${PSQL_B[@]}" < "$MIGRATIONS_DIR/$P4_CLOSEOUT/migration.sql" >/dev/null \
  || fail "Path B: closeout migration failed"

ROWS="$("${PSQL_B[@]}" -tAc "SELECT count(*) FROM program_element_project WHERE pe_code='0601101A';")"
[ "$ROWS" = "2" ] || fail "Path B: existing project rows were lost"
KEPT="$("${PSQL_B[@]}" -tAc "SELECT project_code FROM program_element_project WHERE title='Existing Project';")"
[ "$KEPT" = "AB-12.34" ] || fail "Path B: existing project code changed"

"${PSQL_B[@]}" <<'SQL' >/dev/null
INSERT INTO source_document
  (id, source_key, fiscal_year, budget_cycle, component, document_type, title, source_url, sha256, extraction_method)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'rdte-rehearsal', 2027, 'pb_fy2027',
   'ARMY', 'r2a', 'RDT&E rehearsal', 'file:///rehearsal.pdf',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'structured_import');
INSERT INTO program_element_milestone (id, pe_code, milestone_type, source)
VALUES ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'rehearsal');
SQL

PROVENANCE_PROJECT="
  original_value, original_unit, extraction_artifact_id,
  extraction_artifact_content_sha256, assertion_id,
  verification_candidate_id, verification_run_id, verification_policy_sha256,
  source_pdf_sha256, evidence_ids_jsonb, source_document_id"
PROVENANCE_PROJECT_VALUES="
  '7.000', 'millions', 'artifact-r2a',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'assertion-project-a1', 'candidate-r2a', 'run-r2a',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[\"evidence-project-a1\"]'::jsonb,
  '00000000-0000-0000-0000-000000000001'"

# Valid project total and explicit base component.
"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind, $PROVENANCE_PROJECT)
VALUES
  ('0601101A', 'A1', 'pb_fy2027', 2027, 7.00, 'total', $PROVENANCE_PROJECT_VALUES);" >/dev/null \
  || fail "Path B: valid project position rejected"

"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind, $PROVENANCE_PROJECT)
VALUES
  ('0601101A', 'A1', 'pb_fy2027', 2027, 6.50, 'base',
   '6.500', 'millions', 'artifact-r2a-base',
   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
   'assertion-project-a1-base', 'candidate-r2a', 'run-r2a',
   'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '[\"evidence-project-a1-base\"]'::jsonb,
   '00000000-0000-0000-0000-000000000001');" >/dev/null \
  || fail "Path B: base project position rejected"

# Duplicate natural key rejected.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind, $PROVENANCE_PROJECT)
VALUES
  ('0601101A', 'A1', 'pb_fy2027', 2027, 9.00, 'total', $PROVENANCE_PROJECT_VALUES);" >/dev/null 2>&1; then
  fail "Path B: duplicate natural key accepted"
fi

# Complete proof cannot authorize a nonexistent project.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind, $PROVENANCE_PROJECT)
VALUES
  ('0601101A', 'MISSING', 'pb_fy2027', 2027, 1.00, 'total', $PROVENANCE_PROJECT_VALUES);" >/dev/null 2>&1; then
  fail "Path B: nonexistent project reference accepted"
fi

# Missing proof tuple rejected for a new row.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind)
VALUES ('0601101A', 'A1', 'pb_fy2027', 2028, 8.00, 'total');" >/dev/null 2>&1; then
  fail "Path B: project position without provenance accepted"
fi

PERIOD_PROVENANCE="
  extraction_artifact_id, extraction_artifact_content_sha256, assertion_id,
  verification_candidate_id, verification_run_id, verification_policy_sha256,
  source_pdf_sha256, evidence_ids_jsonb, source_document_id"
PERIOD_PROVENANCE_VALUES="
  'artifact-r4',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  'assertion-cdr', 'candidate-r4', 'run-r4',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[\"evidence-cdr\"]'::jsonb,
  '00000000-0000-0000-0000-000000000001'"

# Valid fiscal-quarter period.
"${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone_schedule_period
  (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind,
   fiscal_year, fiscal_quarter, $PERIOD_PROVENANCE)
VALUES
  ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'planned',
   '3Q FY2028', 'fiscal_quarter', 2028, 3, $PERIOD_PROVENANCE_VALUES);" >/dev/null \
  || fail "Path B: truthful fiscal-quarter period rejected"

# Invalid quarter rejected with otherwise-complete proof.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone_schedule_period
  (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind,
   fiscal_year, fiscal_quarter, $PERIOD_PROVENANCE)
VALUES
  ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'actual',
   '5Q FY2028', 'fiscal_quarter', 2028, 5, $PERIOD_PROVENANCE_VALUES);" >/dev/null 2>&1; then
  fail "Path B: invalid fiscal quarter accepted"
fi

# Exact date attached to a fiscal-quarter shape rejected.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone_schedule_period
  (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind,
   fiscal_year, fiscal_quarter, exact_date, $PERIOD_PROVENANCE)
VALUES
  ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'actual',
   '3Q FY2028 plus date', 'fiscal_quarter', 2028, 3, '2028-01-01',
   $PERIOD_PROVENANCE_VALUES);" >/dev/null 2>&1; then
  fail "Path B: inconsistent period shape accepted"
fi

# Missing period provenance rejected.
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone_schedule_period
  (milestone_id, pe_code, milestone_type, period_role, raw_text, period_kind)
VALUES
  ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'actual',
   'TBD', 'text_only');" >/dev/null 2>&1; then
  fail "Path B: schedule period without provenance accepted"
fi

log "REHEARSAL PASSED — both Phase 4 migrations apply fresh and as an upgrade; no shared database touched"
