#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for the complete Phase 4 migration chain.
# Never connects to a shared database.
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
P4_REPAIR="20260818020000_rdte_phase4_audit_repairs"

log() { echo "[p4-rehearsal] $*"; }
fail() { echo "[p4-rehearsal] FAILED: $*" >&2; exit 1; }

cleanup() {
  rm -rf "$API_ROOT/.p4-rehearsal-migrations" >/dev/null 2>&1 || true
  if [ "${P4_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e POSTGRES_USER="$USER_NAME" \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U "$USER_NAME" -d "$DB_NAME" >/dev/null 2>&1 \
  || fail "PostgreSQL did not become ready"

PSQL=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)
export DATABASE_URL="postgresql://$USER_NAME:$PASSWORD@localhost:$PORT/$DB_NAME"

log "Path A: fresh database to migration tip"
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)
for table in \
  program_element_project_budget_position \
  program_element_project_milestone \
  program_element_project_milestone_schedule_period; do
  "${PSQL[@]}" -tAc "SELECT to_regclass('public.$table');" | grep -q "$table" \
    || fail "Path A: $table is missing"
done
for constraint in \
  program_element_milestone_pe_code_type_key \
  program_element_project_milestone_project_fkey \
  program_element_project_milestone_provenance_check \
  program_element_project_milestone_period_shape_check \
  program_element_project_milestone_period_provenance_check; do
  "${PSQL[@]}" -tAc "SELECT conname FROM pg_constraint WHERE conname='$constraint';" \
    | grep -q "$constraint" || fail "Path A: constraint $constraint is missing"
done
AMOUNT_SCALE="$("${PSQL[@]}" -tAc "SELECT numeric_scale FROM information_schema.columns WHERE table_name='program_element_project_budget_position' AND column_name='amount';")"
[ "$AMOUNT_SCALE" = "6" ] || fail "Path A: project amount scale is $AMOUNT_SCALE"
log "Path A passed"

log "Path B: pre-Phase-4 upgrade"
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;" >/dev/null

TMP_REL=".p4-rehearsal-migrations"
mkdir -p "$API_ROOT/$TMP_REL/migrations"
cp "$API_ROOT/prisma/schema.prisma" "$API_ROOT/$TMP_REL/schema.prisma"
cp "$MIGRATIONS_DIR/migration_lock.toml" "$API_ROOT/$TMP_REL/migrations/" 2>/dev/null || true
for dir in "$MIGRATIONS_DIR"/*/; do
  migration="$(basename "$dir")"
  if [ "$migration" = "$P4_BASE" ] || \
     [ "$migration" = "$P4_CLOSEOUT" ] || \
     [ "$migration" = "$P4_REPAIR" ]; then
    continue
  fi
  cp -r "$dir" "$API_ROOT/$TMP_REL/migrations/"
done
(cd "$API_ROOT" && npx prisma migrate deploy --schema "$TMP_REL/schema.prisma" >/dev/null) \
  || fail "Path B: pre-Phase-4 replay failed"

PSQL_B=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)
"${PSQL_B[@]}" <<'SQL' >/dev/null
INSERT INTO program_element (pe_code, title, source)
VALUES ('0601101A', 'Advanced Technology Development', 'rehearsal');
INSERT INTO program_element_project (pe_code, project_code, title, source, updated_at)
VALUES ('0601101A', 'A1', 'Project A1', 'rehearsal', now()),
       ('0601101A', 'AB-12.34', 'Project AB', 'rehearsal', now());
SQL

"${PSQL_B[@]}" < "$MIGRATIONS_DIR/$P4_BASE/migration.sql" >/dev/null \
  || fail "Path B: base migration failed"
"${PSQL_B[@]}" < "$MIGRATIONS_DIR/$P4_CLOSEOUT/migration.sql" >/dev/null \
  || fail "Path B: closeout migration failed"
"${PSQL_B[@]}" < "$MIGRATIONS_DIR/$P4_REPAIR/migration.sql" >/dev/null \
  || fail "Path B: audit repair migration failed"

# The live legacy writer still owns one PE-level milestone per type.
"${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone (id, pe_code, milestone_type, source)
VALUES ('00000000-0000-0000-0000-000000000002', '0601101A', 'CDR', 'legacy');" >/dev/null
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_milestone (id, pe_code, milestone_type, source)
VALUES ('00000000-0000-0000-0000-000000000003', '0601101A', 'CDR', 'legacy');" >/dev/null 2>&1; then
  fail "Path B: legacy milestone natural key was weakened"
fi

"${PSQL_B[@]}" <<'SQL' >/dev/null
INSERT INTO source_document
  (id, source_key, fiscal_year, budget_cycle, component, document_type, title, source_url, sha256, extraction_method)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'rdte-rehearsal', 2027, 'pb_fy2027',
   'ARMY', 'r4', 'RDT&E rehearsal', 'file:///rehearsal.pdf',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'structured_import');
SQL

PROOF_COLUMNS="
  extraction_artifact_id, extraction_artifact_content_sha256, assertion_id,
  verification_candidate_id, verification_run_id, verification_policy_sha256,
  source_pdf_sha256, evidence_ids_jsonb, source_document_id"
PROOF_VALUES="
  'artifact-r4',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'assertion-r4', 'candidate-r4', 'run-r4',
  'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[\"evidence-r4\"]'::jsonb,
  '00000000-0000-0000-0000-000000000001'"

# Same printed label under different projects is valid; duplicate within one is not.
"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_milestone
  (id, pe_code, project_code, milestone_type, source, $PROOF_COLUMNS)
VALUES
  ('00000000-0000-0000-0000-000000000010', '0601101A', 'A1', 'CDR', 'r4', $PROOF_VALUES),
  ('00000000-0000-0000-0000-000000000011', '0601101A', 'AB-12.34', 'CDR', 'r4',
   'artifact-r4-ab',
   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
   'assertion-r4-ab', 'candidate-r4-ab', 'run-r4-ab',
   'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '[\"evidence-r4-ab\"]'::jsonb,
   '00000000-0000-0000-0000-000000000001');" >/dev/null \
  || fail "Path B: project-scoped milestones rejected"
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_project_milestone
  (pe_code, project_code, milestone_type, source, $PROOF_COLUMNS)
VALUES ('0601101A', 'A1', 'CDR', 'r4', $PROOF_VALUES);" >/dev/null 2>&1; then
  fail "Path B: duplicate project milestone accepted"
fi

POSITION_PROOF_COLUMNS="
  original_value, original_unit, extraction_artifact_id,
  extraction_artifact_content_sha256, assertion_id,
  verification_candidate_id, verification_run_id, verification_policy_sha256,
  source_pdf_sha256, evidence_ids_jsonb, source_document_id"
POSITION_PROOF_VALUES="
  '0.001', 'millions', 'artifact-r2a',
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  'assertion-r2a', 'candidate-r2a', 'run-r2a',
  '1111111111111111111111111111111111111111111111111111111111111111',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[\"evidence-r2a\"]'::jsonb,
  '00000000-0000-0000-0000-000000000001'"
"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_budget_position
  (pe_code, project_code, position_cycle, asserted_fy, amount, value_kind, $POSITION_PROOF_COLUMNS)
VALUES ('0601101A', 'A1', 'pb_fy2027', 2027, 0.001, 'total', $POSITION_PROOF_VALUES);" >/dev/null \
  || fail "Path B: precise project position rejected"
PRECISE_AMOUNT="$("${PSQL_B[@]}" -tAc "SELECT amount::text FROM program_element_project_budget_position WHERE pe_code='0601101A' AND project_code='A1' AND asserted_fy=2027;")"
[ "$PRECISE_AMOUNT" = "0.001000" ] || fail "Path B: precision changed to $PRECISE_AMOUNT"

# Coarse ranges remain raw/structured; exact dates cannot carry coarser fields.
"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_milestone_schedule_period
  (milestone_id, pe_code, project_code, milestone_type, period_role, raw_text,
   period_kind, metadata_jsonb, $PROOF_COLUMNS)
VALUES
  ('00000000-0000-0000-0000-000000000010', '0601101A', 'A1', 'CDR', 'planned',
   'FY2028-FY2029', 'range',
   '{\"rangeStartKind\":\"fiscal_year\",\"rangeEndKind\":\"fiscal_year\"}'::jsonb,
   $PROOF_VALUES);" >/dev/null \
  || fail "Path B: coarse range rejected"
"${PSQL_B[@]}" -c "
INSERT INTO program_element_project_milestone_schedule_period
  (milestone_id, pe_code, project_code, milestone_type, period_role, raw_text,
   period_kind, exact_date, $PROOF_COLUMNS)
VALUES
  ('00000000-0000-0000-0000-000000000011', '0601101A', 'AB-12.34', 'CDR', 'planned',
   '2028-03-14', 'exact_date', '2028-03-14',
   'artifact-r4-ab',
   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
   'assertion-r4-ab', 'candidate-r4-ab', 'run-r4-ab',
   'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '[\"evidence-r4-ab\"]'::jsonb,
   '00000000-0000-0000-0000-000000000001');" >/dev/null \
  || fail "Path B: exact date rejected"
if "${PSQL_B[@]}" -c "
INSERT INTO program_element_project_milestone_schedule_period
  (milestone_id, pe_code, project_code, milestone_type, period_role, raw_text,
   period_kind, exact_date, calendar_year, calendar_month, $PROOF_COLUMNS)
VALUES
  ('00000000-0000-0000-0000-000000000011', '0601101A', 'AB-12.34', 'CDR', 'actual',
   '2028-04-01', 'exact_date', '2028-04-01', 2028, 4,
   'artifact-r4-ab',
   'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
   'assertion-r4-ab', 'candidate-r4-ab', 'run-r4-ab',
   'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   '[\"evidence-r4-ab\"]'::jsonb,
   '00000000-0000-0000-0000-000000000001');" >/dev/null 2>&1; then
  fail "Path B: exact date with coarse calendar fields accepted"
fi

log "REHEARSAL PASSED — fresh and upgrade paths preserve the live writer and add proof-bound project milestones"
