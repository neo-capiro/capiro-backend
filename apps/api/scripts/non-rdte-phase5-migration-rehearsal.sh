#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for the Phase 5 additive native schema.
# Never connects to a shared database.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$API_ROOT/prisma/migrations"
IMAGE="${P5_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P5_REHEARSAL_PG_PORT:-55442}"
NAME="pe-p5-mig-rehearsal"
USER_NAME="postgres"
PASSWORD="postgres"
DB_NAME="capiro"
P5_MIGRATION="20260818030000_non_rdte_phase5_projection_schema"
# Phase 7's canonical-promotion migration (added by a later session) FKs into
# procurement_budget_line, which Phase 5's own migration creates. Written
# back when Phase 5 was the newest phase, this script's "pre-Phase-5"
# baseline was simply "everything except Phase 5's own migration" — correct
# then, but Phase 7 now sits chronologically after Phase 5 in that same
# "everything else" set, so replaying it before Phase 5 exists fails on a
# missing relation. Excluded here for the same reason
# pe-budget-phase7-migration-rehearsal.sh excludes its OWN later add-ons from
# ITS pre-baseline: none of these four are needed until Phase 5's tables
# already exist, and Path A above already proves they apply cleanly at tip.
P7_MIGRATION="20260822010000_pe_budget_phase7_canonical_promotion"
P7_MIGRATION_K="20260822020000_pe_budget_phase7_manual_override_queue_link"
P7_MIGRATION_L="20260902010000_pe_budget_phase7_outbox_drain"
P7_MIGRATION_GAP3="20260903010000_pe_budget_phase7_promotion_eligibility"
# Gap 5 / exact-plan grants land after Phase 7's function + eligibility tables.
# Path B builds a pre-Phase-5 baseline by also omitting Phase 7 itself (P7 FKs
# Phase 5 tables), so these later migrations cannot replay in that baseline:
# 20260907020000 attaches enforce_promotion_ledger_append_only(), which only
# exists once P7_MIGRATION has run. Mirror pe-budget-phase7-migration-rehearsal.sh
# and rdte-phase-4-migration-rehearsal.sh exclusions.
P7_MIGRATION_GAP5_CANDIDATE="20260907010000_pe_budget_phase2_candidate_source_metadata"
P7_MIGRATION_GAP5_PLANS="20260907020000_pe_budget_projection_plan_persistence"
P7_MIGRATION_EXACT_PLAN_GRANTS="20260909020000_pe_budget_phase7_exact_plan_read_grants"
TMP_REL=".p5-rehearsal-migrations"

log() { echo "[p5-rehearsal] $*"; }
fail() { echo "[p5-rehearsal] FAILED: $*" >&2; exit 1; }
cleanup() {
  rm -rf "$API_ROOT/$TMP_REL" >/dev/null 2>&1 || true
  if [ "${P5_REHEARSAL_KEEP:-0}" != "1" ]; then
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

export DATABASE_URL="postgresql://$USER_NAME:$PASSWORD@localhost:$PORT/$DB_NAME"
PSQL=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q)

assert_tables() {
  for table in \
    procurement_budget_line procurement_budget_line_year \
    procurement_distribution_line procurement_detail_fact \
    om_sag om_sag_year om_detail_fact \
    milcon_project milcon_project_year milcon_detail_fact \
    non_rdte_budget_line_source_observation non_rdte_budget_line_relationship; do
    "${PSQL[@]}" -tAc "SELECT to_regclass('public.$table');" | grep -q "$table" \
      || fail "$table is missing"
  done
}

log "Path A: fresh migration chain to repository tip"
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)
assert_tables
for table in procurement_budget_line_year om_sag_year milcon_project_year; do
  scale="$("${PSQL[@]}" -tAc "SELECT numeric_scale FROM information_schema.columns WHERE table_name='$table' AND column_name='amount_millions';")"
  [ "$scale" = "6" ] || fail "$table.amount_millions scale is $scale"
done
log "Path A passed"

log "Path B: upgrade from exact pre-Phase-5 schema"
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" \
  -c "CREATE DATABASE $DB_NAME;" >/dev/null
mkdir -p "$API_ROOT/$TMP_REL/migrations"
cp "$API_ROOT/prisma/schema.prisma" "$API_ROOT/$TMP_REL/schema.prisma"
cp "$MIGRATIONS_DIR/migration_lock.toml" "$API_ROOT/$TMP_REL/migrations/" 2>/dev/null || true
for dir in "$MIGRATIONS_DIR"/*/; do
  migration="$(basename "$dir")"
  if [ "$migration" = "$P5_MIGRATION" ] || \
     [ "$migration" = "$P7_MIGRATION" ] || \
     [ "$migration" = "$P7_MIGRATION_K" ] || \
     [ "$migration" = "$P7_MIGRATION_L" ] || \
     [ "$migration" = "$P7_MIGRATION_GAP3" ] || \
     [ "$migration" = "$P7_MIGRATION_GAP5_CANDIDATE" ] || \
     [ "$migration" = "$P7_MIGRATION_GAP5_PLANS" ] || \
     [ "$migration" = "$P7_MIGRATION_EXACT_PLAN_GRANTS" ]; then
    continue
  fi
  cp -r "$dir" "$API_ROOT/$TMP_REL/migrations/"
done
(cd "$API_ROOT" && npx prisma migrate deploy --schema "$TMP_REL/schema.prisma" >/dev/null) \
  || fail "pre-Phase-5 replay failed"

"${PSQL[@]}" <<'SQL' >/dev/null
INSERT INTO program_element (pe_code, title, source)
VALUES ('0601101A', 'Legacy PE survives Phase 5', 'rehearsal');
INSERT INTO source_document
  (id, source_key, fiscal_year, budget_cycle, component, document_type,
   title, source_url, sha256, extraction_method)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'p5-rehearsal', 2027,
   'pb_fy2027', 'ARMY', 'p1', 'Phase 5 rehearsal', 'file:///p1.pdf',
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
   'structured_import');
SQL

"${PSQL[@]}" < "$MIGRATIONS_DIR/$P5_MIGRATION/migration.sql" >/dev/null \
  || fail "Phase 5 migration failed on upgrade path"
assert_tables
LEGACY_COUNT="$("${PSQL[@]}" -tAc "SELECT count(*) FROM program_element WHERE pe_code='0601101A';")"
[ "$LEGACY_COUNT" = "1" ] || fail "legacy Program Element row changed"
AUTO_ROWS="$("${PSQL[@]}" -tAc "SELECT (SELECT count(*) FROM procurement_budget_line)+(SELECT count(*) FROM om_sag)+(SELECT count(*) FROM milcon_project);")"
[ "$AUTO_ROWS" = "0" ] || fail "migration performed a canonical backfill"

"${PSQL[@]}" <<'SQL' >/dev/null
INSERT INTO procurement_budget_line
  (natural_key, component, account, line_code, printed_line_code, advance_procurement)
VALUES
  ('PROCUREMENT_BLIN:ARMY:2031A:001:base', 'ARMY', '2031A', '001', '001', false);
INSERT INTO procurement_budget_line_year
  (budget_line_id, fiscal_year, amount_millions, original_value, original_unit,
   source_document_id, extraction_artifact_id,
   extraction_artifact_content_sha256, assertion_id,
   verification_candidate_id, verification_run_id, verification_decision_id,
   source_pdf_sha256, evidence_ids_jsonb)
SELECT id, 2027, 12.345678, '12345.678', 'thousands',
  '00000000-0000-0000-0000-000000000001', 'artifact-p1',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'assertion-p1', 'candidate-p1', 'run-p1', 'decision-p1',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '["evidence-p1"]'::jsonb
FROM procurement_budget_line WHERE line_code='001';

INSERT INTO om_sag
  (natural_key, component, account, sag_code, printed_sag_code)
VALUES ('OM_SAG:ARMY:OMA:011', 'ARMY', 'OMA', '011', '011');

INSERT INTO milcon_project
  (natural_key, component, account, project_code, printed_project_code, location)
VALUES
  ('MILCON_PROJECT:ARMY:ABC-1:FORT LIBERTY:MCA', 'ARMY', 'MCA', 'ABC-1', 'ABC-1', 'FORT LIBERTY'),
  ('MILCON_PROJECT:ARMY:ABC-1:FORT LIBERTY:AFHC', 'ARMY', 'AFHC', 'ABC-1', 'ABC-1', 'FORT LIBERTY');
SQL

AMOUNT="$("${PSQL[@]}" -tAc "SELECT amount_millions::text FROM procurement_budget_line_year;")"
[ "$AMOUNT" = "12.345678" ] || fail "exact six-decimal amount changed to $AMOUNT"
MILCON_COUNT="$("${PSQL[@]}" -tAc "SELECT count(*) FROM milcon_project WHERE project_code='ABC-1';")"
[ "$MILCON_COUNT" = "2" ] || fail "same project/location across accounts collapsed"

if "${PSQL[@]}" -c "
INSERT INTO procurement_budget_line_year
  (budget_line_id, fiscal_year, amount_millions, original_value, original_unit,
   source_document_id, extraction_artifact_id,
   extraction_artifact_content_sha256, assertion_id,
   verification_candidate_id, verification_run_id, verification_decision_id,
   source_pdf_sha256, evidence_ids_jsonb)
SELECT id, 2028, 1, '1', 'millions',
  '00000000-0000-0000-0000-000000000001', 'artifact-bad',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'assertion-bad', 'candidate-bad', 'run-bad', 'decision-bad',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '[]'::jsonb
FROM procurement_budget_line WHERE line_code='001';" >/dev/null 2>&1; then
  fail "empty evidence ledger was accepted"
fi
if "${PSQL[@]}" -c "
INSERT INTO non_rdte_budget_line_relationship
  (from_family, from_natural_key, to_family, to_natural_key,
   relationship_type, explicit_in_source, source_document_id,
   extraction_artifact_id, extraction_artifact_content_sha256, assertion_id,
   verification_candidate_id, verification_run_id, verification_decision_id,
   source_pdf_sha256, evidence_ids_jsonb)
VALUES ('procurement','PROCUREMENT_BLIN:ARMY:2031A:001:base','rdte','0601101A',
  'references_pe', false, '00000000-0000-0000-0000-000000000001',
  'artifact-p40',
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'assertion-rel', 'candidate-rel', 'run-rel', 'decision-rel',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '["evidence-rel"]'::jsonb);" >/dev/null 2>&1; then
  fail "non-explicit relationship was accepted"
fi

log "REHEARSAL PASSED — fresh and upgrade paths are additive, exact, proof-bound, and identity-safe"
