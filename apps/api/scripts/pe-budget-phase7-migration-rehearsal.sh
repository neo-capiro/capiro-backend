#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for the Phase 7 canonical promotion schema.
#
# Proves the Workstream D acceptance criteria against a real database:
#   * fresh migration chain and upgrade from the exact pre-Phase-7 schema
#   * canonical mutation requires capiro_pe_promoter
#   * the general serve role cannot write canonical rows or move the pointer
#   * activated snapshot rows are immutable for every role
#   * activation refuses incomplete scopes, stale expectations, and races
#   * authorization is one-use and plan-hash exact
#   * rollback is a forward pointer transition that deletes nothing
#
# NEVER connects to a shared database. The container is destroyed on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$API_ROOT/prisma/migrations"
# pgvector, not plain postgres: the migration chain installs the `vector`
# extension in its first migration.
IMAGE="${P7_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P7_REHEARSAL_PG_PORT:-55447}"
NAME="pe-p7-mig-rehearsal"
USER_NAME="postgres"
PASSWORD="postgres"
DB_NAME="capiro"
P7_MIGRATION="20260822010000_pe_budget_phase7_canonical_promotion"
TMP_REL=".p7-rehearsal-migrations"

PASS_COUNT=0

log()  { echo "[p7-rehearsal] $*"; }
fail() { echo "[p7-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p7-rehearsal]   ok  $*"; }

cleanup() {
  rm -rf "$API_ROOT/$TMP_REL" >/dev/null 2>&1 || true
  if [ "${P7_REHEARSAL_KEEP:-0}" != "1" ]; then
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
QUERY=(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -tAc)

# Run SQL expected to succeed.
run_sql() { "${PSQL[@]}" -c "$1" >/dev/null || fail "expected success: $1"; }

# Run SQL expected to be refused by a constraint, trigger, or privilege check.
expect_fail() {
  local label="$1"; local sql="$2"
  if "${PSQL[@]}" -c "$sql" >/dev/null 2>&1; then
    fail "$label — the database ACCEPTED a statement it must refuse"
  fi
  ok "$label — refused"
}

q() { "${QUERY[@]}" "$1"; }

P7_TABLES="defense_budget_canonical_snapshot defense_budget_active_snapshot \
defense_budget_promotion_plan defense_budget_promotion_authorization \
defense_budget_promotion_run defense_budget_promotion_item \
defense_budget_promotion_activation defense_budget_promotion_outbox \
defense_budget_compatibility_projection_run defense_budget_rollback_record \
defense_budget_canonical_row defense_budget_promotion_audit"

assert_tables() {
  for table in $P7_TABLES; do
    [ "$(q "SELECT to_regclass('public.$table') IS NOT NULL;")" = "t" ] \
      || fail "$table is missing"
  done
}

# =============================================================================
log "Path A: fresh migration chain to repository tip"
# =============================================================================
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null) \
  || fail "fresh migration chain failed"
assert_tables
ok "all 12 Phase 7 tables created on the fresh chain"

[ "$(q "SELECT count(*) FROM pg_roles WHERE rolname='capiro_pe_promoter';")" = "1" ] \
  || fail "capiro_pe_promoter was not created"
ok "capiro_pe_promoter role exists"

for attr in rolsuper rolcreatedb rolcreaterole rolbypassrls rolreplication; do
  [ "$(q "SELECT $attr FROM pg_roles WHERE rolname='capiro_pe_promoter';")" = "f" ] \
    || fail "capiro_pe_promoter has $attr"
done
ok "capiro_pe_promoter holds no superuser/DDL/role-creation/bypassrls attribute"

# =============================================================================
log "Path B: upgrade from the exact pre-Phase-7 schema"
# =============================================================================
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP DATABASE IF EXISTS $DB_NAME;" -c "CREATE DATABASE $DB_NAME;" >/dev/null
# Roles are cluster-scoped and survive the DROP DATABASE; drop them so the
# upgrade path proves the migration creates them from nothing.
docker exec -i "$NAME" psql -U "$USER_NAME" -d postgres -v ON_ERROR_STOP=1 -q \
  -c "DROP ROLE IF EXISTS capiro_pe_promoter;" -c "DROP ROLE IF EXISTS capiro_app;" >/dev/null

mkdir -p "$API_ROOT/$TMP_REL/migrations"
cp "$API_ROOT/prisma/schema.prisma" "$API_ROOT/$TMP_REL/schema.prisma"
cp "$MIGRATIONS_DIR/migration_lock.toml" "$API_ROOT/$TMP_REL/migrations/" 2>/dev/null || true
for dir in "$MIGRATIONS_DIR"/*/; do
  migration="$(basename "$dir")"
  [ "$migration" = "$P7_MIGRATION" ] && continue
  cp -r "$dir" "$API_ROOT/$TMP_REL/migrations/"
done
(cd "$API_ROOT" && npx prisma migrate deploy --schema "$TMP_REL/schema.prisma" >/dev/null) \
  || fail "pre-Phase-7 replay failed"

# Legacy data that must survive an additive migration untouched.
"${PSQL[@]}" <<'SQL' >/dev/null
INSERT INTO program_element (pe_code, title, source)
VALUES ('0601101A', 'Legacy PE survives Phase 7', 'rehearsal');
SQL

"${PSQL[@]}" < "$MIGRATIONS_DIR/$P7_MIGRATION/migration.sql" >/dev/null \
  || fail "Phase 7 migration failed on the upgrade path"
assert_tables
ok "Phase 7 migration applies cleanly on top of the pre-Phase-7 schema"

[ "$(q "SELECT count(*) FROM program_element WHERE pe_code='0601101A';")" = "1" ] \
  || fail "legacy Program Element row changed"
ok "legacy rows untouched"

CANON_ROWS="$(q "SELECT count(*) FROM defense_budget_canonical_row;")"
[ "$CANON_ROWS" = "0" ] || fail "migration performed a canonical backfill ($CANON_ROWS rows)"
ok "migration wrote no canonical data"

# =============================================================================
log "Fixtures"
# =============================================================================
SHA_A="$(printf 'a%.0s' $(seq 1 64))"
SHA_B="$(printf 'b%.0s' $(seq 1 64))"

"${PSQL[@]}" <<SQL >/dev/null
INSERT INTO defense_budget_canonical_snapshot
  (id, snapshot_key, environment, cycle_id, fiscal_year, status,
   required_scopes, completed_scopes, mapping_registry_hash)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'snap-baseline', 'rehearsal',
   'cycle-fy2027', 2027, 'STAGING', '["om"]'::jsonb, '[]'::jsonb, '$SHA_A');

INSERT INTO defense_budget_promotion_plan
  (plan_id, plan_hash, eligibility_hash, mapping_registry_version,
   mapping_registry_hash, cycle_id, fiscal_year, scope, scope_hash, mode,
   proposed_snapshot_id, item_count, blocked_count, plan_document)
VALUES
  ('plan-1', '$SHA_B', '$SHA_A', '1.0.0', '$SHA_A', 'cycle-fy2027', 2027,
   '{"families":["om"]}'::jsonb, '$SHA_A', 'baseline_hydration',
   '11111111-1111-1111-1111-111111111111', 1, 0, '{}'::jsonb);

INSERT INTO defense_budget_promotion_authorization
  (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
   authorizer_actor_id, authorizer_role, reason, issued_at, expires_at,
   segregation, authorization_hash)
VALUES
  ('auth-1', 'plan-1', '$SHA_B', '$SHA_A', '$SHA_A', 'actor-admin', 'capiro_admin',
   'baseline hydration', now(), now() + interval '1 hour', '{}'::jsonb, '$SHA_A');

INSERT INTO defense_budget_promotion_run
  (id, run_key, plan_id, plan_hash, authorization_id, snapshot_id, executor_identity)
VALUES
  ('22222222-2222-2222-2222-222222222222', 'run-1', 'plan-1', '$SHA_B', 'auth-1',
   '11111111-1111-1111-1111-111111111111', 'fargate:promoter');
SQL
ok "snapshot, plan, authorization, and run created"

insert_canonical_row() {
  local key="$1"; local snapshot="$2"
  "${PSQL[@]}" -c "
INSERT INTO defense_budget_canonical_row
  (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key,
   family, fiscal_year, funding_field, canonical_row_hash,
   money_original_value, money_original_unit, money_value_millions,
   direct_or_derived, source_projection_id, source_assertion_id, evidence_ids,
   artifact_id, artifact_content_sha256, verification_candidate_id,
   verification_run_id, source_document_id, source_pdf_sha256, mapping_registry_hash)
VALUES
  ('$snapshot', '22222222-2222-2222-2222-222222222222',
   'canonical_om_sag_year', '$key', 'om', 2027, 'request', '$SHA_A',
   '1250', 'thousands', 1.25, 'direct', 'proj-1', 'assert-1', '[\"ev-1\"]'::jsonb,
   'artifact-1', '$SHA_A', 'cand-1', 'run-1', 'doc-1', '$SHA_B', '$SHA_A');"
}

insert_canonical_row 'ARMY|OMA|SAG-111|2027|request' '11111111-1111-1111-1111-111111111111' >/dev/null \
  || fail "the promoter path could not insert a canonical row while STAGING"
ok "canonical row inserted into a STAGING snapshot"

[ "$(q "SELECT money_value_millions::text FROM defense_budget_canonical_row;")" = "1.250000000" ] \
  || fail "exact decimal money was altered"
ok "money stored exactly as NUMERIC(24,9) alongside its printed string"

# =============================================================================
log "Role boundary"
# =============================================================================
expect_fail "general serve role writes a canonical row" "
SET ROLE capiro_app;
INSERT INTO defense_budget_canonical_row
  (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key,
   family, canonical_row_hash, direct_or_derived, source_projection_id,
   source_assertion_id, evidence_ids, artifact_id, artifact_content_sha256,
   verification_candidate_id, verification_run_id, source_document_id,
   source_pdf_sha256, mapping_registry_hash)
VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'canonical_om_sag', 'ARMY|OMA|SAG-999', 'om', '$SHA_A', 'direct', 'p', 'a',
   '[]'::jsonb, 'art', '$SHA_A', 'c', 'r', 'd', '$SHA_B', '$SHA_A');"

expect_fail "general serve role moves the activation pointer" "
SET ROLE capiro_app;
INSERT INTO defense_budget_active_snapshot (environment, snapshot_id, activation_id)
VALUES ('rehearsal', '11111111-1111-1111-1111-111111111111', gen_random_uuid());"

expect_fail "promoter performs DDL" "
SET ROLE capiro_pe_promoter;
CREATE TABLE promoter_should_not_create (id int);"

expect_fail "promoter deletes a canonical row" "
SET ROLE capiro_pe_promoter;
DELETE FROM defense_budget_canonical_row;"

# Separate -c flags share one session, so SET ROLE persists into the SELECT.
PROMOTER_READS="$(docker exec -i "$NAME" psql -U "$USER_NAME" -d "$DB_NAME" -tA \
  -v ON_ERROR_STOP=1 \
  -c "SET ROLE capiro_pe_promoter" \
  -c "SELECT count(*) FROM om_sag" 2>&1 | tr -d '\r' | tail -1)"
[ "$PROMOTER_READS" = "0" ] \
  || fail "promoter could not read verified projections (got: '$PROMOTER_READS')"
ok "promoter reads verified projection tables — allowed"

# =============================================================================
log "Activation preconditions"
# =============================================================================
run_sql "
INSERT INTO defense_budget_promotion_activation
  (id, activation_key, run_id, environment, previous_snapshot_id, new_snapshot_id,
   authorization_id, activated_by)
VALUES
  ('33333333-3333-3333-3333-333333333333', 'act-1',
   '22222222-2222-2222-2222-222222222222', 'rehearsal', NULL,
   '11111111-1111-1111-1111-111111111111', 'auth-1', 'fargate:promoter');"
ok "activation ledger row written"

expect_fail "activate a snapshot whose required scopes are incomplete" "
UPDATE defense_budget_canonical_snapshot SET status='READY', snapshot_hash='$SHA_A'
  WHERE id='11111111-1111-1111-1111-111111111111';
INSERT INTO defense_budget_active_snapshot (environment, snapshot_id, activation_id)
VALUES ('rehearsal', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333');"

run_sql "
UPDATE defense_budget_canonical_snapshot
   SET completed_scopes='[\"om\"]'::jsonb, status='READY', snapshot_hash='$SHA_A'
 WHERE id='11111111-1111-1111-1111-111111111111';"

expect_fail "activate a snapshot that is still STAGING" "
UPDATE defense_budget_canonical_snapshot SET status='STAGING'
  WHERE id='11111111-1111-1111-1111-111111111111';
INSERT INTO defense_budget_active_snapshot (environment, snapshot_id, activation_id)
VALUES ('rehearsal', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333');"

run_sql "
UPDATE defense_budget_canonical_snapshot SET status='READY'
  WHERE id='11111111-1111-1111-1111-111111111111';
INSERT INTO defense_budget_active_snapshot (environment, snapshot_id, activation_id)
VALUES ('rehearsal', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333');
UPDATE defense_budget_canonical_snapshot SET status='ACTIVE', activated_at=now()
  WHERE id='11111111-1111-1111-1111-111111111111';"
ok "baseline activation succeeded"

[ "$(q "SELECT count(*) FROM defense_budget_active_snapshot;")" = "1" ] \
  || fail "more than one active pointer row"
ok "exactly one active snapshot pointer"

expect_fail "a second active pointer for the same domain/environment" "
INSERT INTO defense_budget_active_snapshot (environment, snapshot_id, activation_id)
VALUES ('rehearsal', '11111111-1111-1111-1111-111111111111',
        '33333333-3333-3333-3333-333333333333');"

expect_fail "delete the activation pointer" "DELETE FROM defense_budget_active_snapshot;"

# =============================================================================
log "Immutability of activated data"
# =============================================================================
expect_fail "update a canonical row in an ACTIVE snapshot" "
UPDATE defense_budget_canonical_row SET money_value_millions = 99;"

expect_fail "delete a canonical row in an ACTIVE snapshot" "
DELETE FROM defense_budget_canonical_row;"

expect_fail "insert a new canonical row into an ACTIVE snapshot" "
INSERT INTO defense_budget_canonical_row
  (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key,
   family, canonical_row_hash, direct_or_derived, source_projection_id,
   source_assertion_id, evidence_ids, artifact_id, artifact_content_sha256,
   verification_candidate_id, verification_run_id, source_document_id,
   source_pdf_sha256, mapping_registry_hash)
VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
   'canonical_om_sag', 'ARMY|OMA|SAG-222', 'om', '$SHA_A', 'direct', 'p', 'a',
   '[]'::jsonb, 'art', '$SHA_A', 'c', 'r', 'd', '$SHA_B', '$SHA_A');"

expect_fail "delete a canonical snapshot" "
DELETE FROM defense_budget_canonical_snapshot
 WHERE id='11111111-1111-1111-1111-111111111111';"

expect_fail "change a published snapshot hash" "
UPDATE defense_budget_canonical_snapshot SET snapshot_hash='$SHA_B'
 WHERE id='11111111-1111-1111-1111-111111111111';"

expect_fail "modify an activation ledger row" "
UPDATE defense_budget_promotion_activation SET activated_by='someone-else';"

expect_fail "modify a promotion plan" "
UPDATE defense_budget_promotion_plan SET blocked_count = 5;"

run_sql "
INSERT INTO defense_budget_promotion_audit (attempt_kind, outcome, reasons, detail)
VALUES ('ELIGIBILITY', 'REFUSED', '[\"open_blocking_conflict\"]'::jsonb, 'rehearsal');"
expect_fail "delete an audit record" "DELETE FROM defense_budget_promotion_audit;"
expect_fail "record a refusal with no reason" "
INSERT INTO defense_budget_promotion_audit (attempt_kind, outcome, reasons)
VALUES ('ELIGIBILITY', 'REFUSED', '[]'::jsonb);"

# =============================================================================
log "Authorization is exact and one-use"
# =============================================================================
run_sql "
UPDATE defense_budget_promotion_authorization
   SET consumed_at = now(), consumed_by_run_id = '22222222-2222-2222-2222-222222222222'
 WHERE authorization_id = 'auth-1';"
ok "authorization consumption recorded"

expect_fail "consume the same authorization twice" "
UPDATE defense_budget_promotion_authorization
   SET consumed_at = now(), consumed_by_run_id = '22222222-2222-2222-2222-222222222222'
 WHERE authorization_id = 'auth-1';"

expect_fail "alter an authorization's scope after issue" "
UPDATE defense_budget_promotion_authorization SET scope_hash='$SHA_B'
 WHERE authorization_id='auth-1';"

expect_fail "delete an authorization" "
DELETE FROM defense_budget_promotion_authorization WHERE authorization_id='auth-1';"

expect_fail "run against a plan hash the authorization did not approve" "
INSERT INTO defense_budget_promotion_run
  (run_key, plan_id, plan_hash, authorization_id, snapshot_id, executor_identity)
VALUES ('run-wrong-hash', 'plan-1', '$SHA_A', 'auth-1',
        '11111111-1111-1111-1111-111111111111', 'fargate:promoter');"

run_sql "
INSERT INTO defense_budget_promotion_plan
  (plan_id, plan_hash, eligibility_hash, mapping_registry_version,
   mapping_registry_hash, cycle_id, fiscal_year, scope, scope_hash, mode,
   proposed_snapshot_id, item_count, blocked_count, plan_document)
VALUES ('plan-blocked', '$SHA_A', '$SHA_A', '1.0.0', '$SHA_A', 'cycle-fy2027', 2027,
        '{}'::jsonb, '$SHA_A', 'new_cycle', '11111111-1111-1111-1111-111111111111',
        3, 1, '{}'::jsonb);
INSERT INTO defense_budget_promotion_authorization
  (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
   authorizer_actor_id, authorizer_role, reason, issued_at, expires_at,
   segregation, authorization_hash)
VALUES ('auth-blocked', 'plan-blocked', '$SHA_A', '$SHA_A', '$SHA_A', 'actor-admin',
        'capiro_admin', 'should not run', now(), now() + interval '1 hour',
        '{}'::jsonb, '$SHA_A');"

expect_fail "execute a plan that still has blocked items" "
INSERT INTO defense_budget_promotion_run
  (run_key, plan_id, plan_hash, authorization_id, snapshot_id, executor_identity)
VALUES ('run-blocked', 'plan-blocked', '$SHA_A', 'auth-blocked',
        '11111111-1111-1111-1111-111111111111', 'fargate:promoter');"

run_sql "
INSERT INTO defense_budget_promotion_authorization
  (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
   authorizer_actor_id, authorizer_role, reason, issued_at, expires_at,
   segregation, authorization_hash)
VALUES ('auth-expired', 'plan-1', '$SHA_B', '$SHA_A', '$SHA_A', 'actor-admin',
        'capiro_admin', 'already expired', now() - interval '2 hours',
        now() - interval '1 hour', '{}'::jsonb, '$SHA_A');"

expect_fail "activate with an expired authorization" "
INSERT INTO defense_budget_promotion_activation
  (activation_key, run_id, environment, previous_snapshot_id, new_snapshot_id,
   authorization_id, activated_by)
VALUES ('act-expired', '22222222-2222-2222-2222-222222222222', 'rehearsal',
        '11111111-1111-1111-1111-111111111111',
        '11111111-1111-1111-1111-111111111111', 'auth-expired', 'fargate:promoter');"

expect_fail "reuse an activation key (exactly-once activation)" "
INSERT INTO defense_budget_promotion_activation
  (activation_key, run_id, environment, new_snapshot_id, authorization_id, activated_by)
VALUES ('act-1', '22222222-2222-2222-2222-222222222222', 'rehearsal',
        '11111111-1111-1111-1111-111111111111', 'auth-1', 'fargate:promoter');"

# =============================================================================
log "Row-level canonical invariants"
# =============================================================================
NEW_SNAP='44444444-4444-4444-4444-444444444444'
run_sql "
INSERT INTO defense_budget_canonical_snapshot
  (id, snapshot_key, environment, cycle_id, fiscal_year, status,
   required_scopes, completed_scopes, mapping_registry_hash)
VALUES ('$NEW_SNAP', 'snap-cycle-2', 'rehearsal', 'cycle-fy2027', 2027, 'STAGING',
        '[\"om\"]'::jsonb, '[\"om\"]'::jsonb, '$SHA_A');"

canonical_insert_variant() {
  echo "
INSERT INTO defense_budget_canonical_row
  (snapshot_id, promotion_run_id, canonical_entity, canonical_natural_key,
   family, fiscal_year, funding_field, stage, canonical_row_hash,
   money_original_value, money_original_unit, money_value_millions,
   binding_status, direct_or_derived, source_projection_id, source_assertion_id,
   evidence_ids, artifact_id, artifact_content_sha256, verification_candidate_id,
   verification_run_id, source_document_id, source_pdf_sha256,
   mapping_registry_hash, enactment_proof_id)
VALUES ('$NEW_SNAP', '22222222-2222-2222-2222-222222222222',
   'canonical_stage_position', '$1', 'om', 2027, $2, $3, '$SHA_A',
   $4, $5, $6, $7, 'direct', 'proj-x', 'assert-x', '[]'::jsonb, 'art', '$SHA_A',
   'c', 'r', 'd', '$SHA_B', '$SHA_A', $8);"
}

expect_fail "enacted position with no enactment proof" \
  "$(canonical_insert_variant 'k-enacted' "'enacted'" "'public_law'" "'1'" "'millions'" "1" "'accepted'" "NULL")"

expect_fail "NDAA conference stage writing the appropriations conference field" \
  "$(canonical_insert_variant 'k-crossed' "'conference'" "'ndaa_conference'" "'1'" "'millions'" "1" "'accepted'" "NULL")"

expect_fail "authorization stage writing an appropriations field" \
  "$(canonical_insert_variant 'k-hasc-bad' "'hacDMark'" "'hasc'" "'1'" "'millions'" "1" "'accepted'" "NULL")"

expect_fail "candidate identity binding stored as canonical" \
  "$(canonical_insert_variant 'k-candidate' "'hascMark'" "'hasc'" "'1'" "'millions'" "1" "'candidate'" "NULL")"

expect_fail "normalized money with no printed original value" \
  "$(canonical_insert_variant 'k-partial-money' "'hascMark'" "'hasc'" "NULL" "NULL" "1" "'accepted'" "NULL")"

run_sql "$(canonical_insert_variant 'k-valid' "'hascMark'" "'hasc'" "'1'" "'millions'" "1" "'accepted'" "NULL")"
ok "a correctly-formed stage position is accepted"

expect_fail "duplicate canonical natural key within one snapshot (no last-wins)" \
  "$(canonical_insert_variant 'k-valid' "'hascMark'" "'hasc'" "'2'" "'millions'" "2" "'accepted'" "NULL")"

# =============================================================================
log "Outbox suppression"
# =============================================================================
expect_fail "initial hydration emitting an un-suppressed alert" "
INSERT INTO defense_budget_promotion_outbox
  (activation_id, dedupe_key, new_snapshot_id, canonical_entity,
   canonical_natural_key, family, change_classification, suppress_alert)
VALUES ('33333333-3333-3333-3333-333333333333', 'dedupe-hydration',
        '11111111-1111-1111-1111-111111111111', 'canonical_om_sag_year',
        'k1', 'om', 'initial_hydration', false);"

expect_fail "correction emitting an un-suppressed alert" "
INSERT INTO defense_budget_promotion_outbox
  (activation_id, dedupe_key, new_snapshot_id, canonical_entity,
   canonical_natural_key, family, change_classification, suppress_alert)
VALUES ('33333333-3333-3333-3333-333333333333', 'dedupe-correction',
        '11111111-1111-1111-1111-111111111111', 'canonical_om_sag_year',
        'k1', 'om', 'correction', false);"

expect_fail "rollback emitting an un-suppressed alert" "
INSERT INTO defense_budget_promotion_outbox
  (activation_id, dedupe_key, new_snapshot_id, canonical_entity,
   canonical_natural_key, family, change_classification, suppress_alert)
VALUES ('33333333-3333-3333-3333-333333333333', 'dedupe-rollback',
        '11111111-1111-1111-1111-111111111111', 'canonical_om_sag_year',
        'k1', 'om', 'rollback', false);"

run_sql "
INSERT INTO defense_budget_promotion_outbox
  (activation_id, dedupe_key, new_snapshot_id, canonical_entity,
   canonical_natural_key, family, change_classification, suppress_alert)
VALUES ('33333333-3333-3333-3333-333333333333', 'dedupe-material',
        '11111111-1111-1111-1111-111111111111', 'canonical_om_sag_year',
        'k1', 'om', 'material_change', false);"
ok "a material official change may carry an alert"

expect_fail "duplicate outbox dedupe key" "
INSERT INTO defense_budget_promotion_outbox
  (activation_id, dedupe_key, new_snapshot_id, canonical_entity,
   canonical_natural_key, family, change_classification, suppress_alert)
VALUES ('33333333-3333-3333-3333-333333333333', 'dedupe-material',
        '11111111-1111-1111-1111-111111111111', 'canonical_om_sag_year',
        'k2', 'om', 'material_change', false);"

# =============================================================================
log "Second activation, drift, and rollback"
# =============================================================================
run_sql "
UPDATE defense_budget_canonical_snapshot SET status='READY', snapshot_hash='$SHA_B'
  WHERE id='$NEW_SNAP';
INSERT INTO defense_budget_promotion_authorization
  (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
   expected_active_snapshot_id, authorizer_actor_id, authorizer_role, reason,
   issued_at, expires_at, segregation, authorization_hash)
VALUES ('auth-2', 'plan-1', '$SHA_B', '$SHA_A', '$SHA_A',
        '11111111-1111-1111-1111-111111111111', 'actor-admin', 'capiro_admin',
        'cycle 2', now(), now() + interval '1 hour', '{}'::jsonb, '$SHA_A');
INSERT INTO defense_budget_promotion_activation
  (id, activation_key, run_id, environment, previous_snapshot_id, new_snapshot_id,
   authorization_id, activated_by)
VALUES ('55555555-5555-5555-5555-555555555555', 'act-2',
        '22222222-2222-2222-2222-222222222222', 'rehearsal',
        '11111111-1111-1111-1111-111111111111', '$NEW_SNAP', 'auth-2', 'fargate:promoter');"

# A concurrent activation that believed nothing was active must lose the race
# against the one that correctly named the live snapshot as its predecessor.
run_sql "
INSERT INTO defense_budget_promotion_activation
  (id, activation_key, run_id, environment, previous_snapshot_id, new_snapshot_id,
   authorization_id, activated_by)
VALUES ('66666666-6666-6666-6666-666666666666', 'act-stale',
        '22222222-2222-2222-2222-222222222222', 'rehearsal', NULL,
        '$NEW_SNAP', 'auth-2', 'fargate:promoter');"

expect_fail "activation whose expected previous snapshot is not the live one" "
UPDATE defense_budget_active_snapshot
   SET snapshot_id='$NEW_SNAP', activation_id='66666666-6666-6666-6666-666666666666'
 WHERE environment='rehearsal';"

# An activation record must also agree about which snapshot it activates.
expect_fail "pointer moved to a snapshot the activation record does not name" "
UPDATE defense_budget_active_snapshot
   SET snapshot_id='11111111-1111-1111-1111-111111111111',
       activation_id='55555555-5555-5555-5555-555555555555'
 WHERE environment='rehearsal';"

run_sql "
UPDATE defense_budget_active_snapshot
   SET snapshot_id='$NEW_SNAP', activation_id='55555555-5555-5555-5555-555555555555',
       updated_at=now()
 WHERE environment='rehearsal';
UPDATE defense_budget_canonical_snapshot SET status='ACTIVE', activated_at=now()
  WHERE id='$NEW_SNAP';
UPDATE defense_budget_canonical_snapshot SET status='SUPERSEDED', superseded_at=now()
  WHERE id='11111111-1111-1111-1111-111111111111';"
ok "new-cycle activation moved the pointer atomically"

[ "$(q "SELECT snapshot_id FROM defense_budget_active_snapshot;")" = "$NEW_SNAP" ] \
  || fail "pointer did not move"
ok "active pointer now names the new snapshot"

# Rollback: forward pointer transition back to the prior immutable snapshot.
run_sql "
INSERT INTO defense_budget_promotion_authorization
  (authorization_id, plan_id, plan_hash, eligibility_hash, scope_hash,
   expected_active_snapshot_id, authorizer_actor_id, authorizer_role, reason,
   issued_at, expires_at, segregation, authorization_hash)
VALUES ('auth-rollback', 'plan-1', '$SHA_B', '$SHA_A', '$SHA_A', '$NEW_SNAP',
        'actor-admin', 'capiro_admin', 'rollback', now(),
        now() + interval '1 hour', '{}'::jsonb, '$SHA_A');
UPDATE defense_budget_canonical_snapshot SET status='READY'
  WHERE id='11111111-1111-1111-1111-111111111111';
INSERT INTO defense_budget_promotion_activation
  (id, activation_key, run_id, environment, previous_snapshot_id, new_snapshot_id,
   authorization_id, activation_kind, activated_by)
VALUES ('77777777-7777-7777-7777-777777777777', 'act-rollback',
        '22222222-2222-2222-2222-222222222222', 'rehearsal', '$NEW_SNAP',
        '11111111-1111-1111-1111-111111111111', 'auth-rollback', 'ROLLBACK',
        'fargate:promoter');
UPDATE defense_budget_active_snapshot
   SET snapshot_id='11111111-1111-1111-1111-111111111111',
       activation_id='77777777-7777-7777-7777-777777777777', updated_at=now()
 WHERE environment='rehearsal';
UPDATE defense_budget_canonical_snapshot SET status='ACTIVE'
  WHERE id='11111111-1111-1111-1111-111111111111';
UPDATE defense_budget_canonical_snapshot SET status='ROLLED_BACK'
  WHERE id='$NEW_SNAP';
INSERT INTO defense_budget_rollback_record
  (rollback_key, from_snapshot_id, to_snapshot_id, authorization_id,
   activation_id, reason, created_by)
VALUES ('rb-1', '$NEW_SNAP', '11111111-1111-1111-1111-111111111111',
        'auth-rollback', '77777777-7777-7777-7777-777777777777',
        'rehearsal rollback', 'fargate:promoter');"
ok "rollback reactivated the prior snapshot"

[ "$(q "SELECT count(*) FROM defense_budget_canonical_snapshot;")" = "2" ] \
  || fail "rollback removed a snapshot"
ok "both snapshots still exist after rollback — no history deleted"

expect_fail "delete the rolled-back snapshot's canonical rows" "
DELETE FROM defense_budget_canonical_row WHERE snapshot_id='$NEW_SNAP';"

expect_fail "modify a rollback record" "
UPDATE defense_budget_rollback_record SET reason='rewritten';"

[ "$(q "SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id='$NEW_SNAP';")" = "1" ] \
  || fail "rolled-back snapshot lost its rows"
ok "rolled-back snapshot retains its rows and remains auditable"

# =============================================================================
log "Workstream E: staged rows are invisible until the pointer moves"
# =============================================================================
# The promotion engine stages into a STAGING snapshot and only then activates.
# This proves the property that makes that safe: a product read that resolves
# through the active-snapshot pointer cannot see staged rows, so a user never
# observes a half-promoted cycle.

STAGE_SNAP='88888888-8888-8888-8888-888888888888'
run_sql "
INSERT INTO defense_budget_canonical_snapshot
  (id, snapshot_key, environment, cycle_id, fiscal_year, status,
   required_scopes, completed_scopes, mapping_registry_hash)
VALUES ('$STAGE_SNAP', 'snap-staging', 'rehearsal', 'cycle-fy2028', 2028, 'STAGING',
        '[\"om\"]'::jsonb, '[]'::jsonb, '$SHA_A');"

insert_canonical_row 'ARMY|OMA|SAG-777|2028|request' "$STAGE_SNAP" >/dev/null \
  || fail "could not stage a row into a STAGING snapshot"
ok "row staged into a STAGING snapshot"

# The canonical read path: rows of whatever snapshot the pointer names.
ACTIVE_VISIBLE="$(q "
SELECT count(*) FROM defense_budget_canonical_row r
  JOIN defense_budget_active_snapshot a ON a.snapshot_id = r.snapshot_id
 WHERE a.environment = 'rehearsal';")"
STAGED_TOTAL="$(q "SELECT count(*) FROM defense_budget_canonical_row WHERE snapshot_id='$STAGE_SNAP';")"

[ "$STAGED_TOTAL" = "1" ] || fail "the staged row was not written"
ok "staged row exists in the table ($STAGED_TOTAL)"

STAGED_VISIBLE="$(q "
SELECT count(*) FROM defense_budget_canonical_row r
  JOIN defense_budget_active_snapshot a ON a.snapshot_id = r.snapshot_id
 WHERE a.environment = 'rehearsal' AND r.snapshot_id = '$STAGE_SNAP';")"
[ "$STAGED_VISIBLE" = "0" ] || fail "staged rows are visible through the active pointer"
ok "staged rows are invisible to an active-snapshot read — no partial cycle is observable"

# A read never mixes snapshots: every row reachable through the pointer belongs
# to exactly one snapshot.
DISTINCT_SNAPS="$(q "
SELECT count(DISTINCT r.snapshot_id) FROM defense_budget_canonical_row r
  JOIN defense_budget_active_snapshot a ON a.snapshot_id = r.snapshot_id
 WHERE a.environment = 'rehearsal';")"
[ "$DISTINCT_SNAPS" = "1" ] || fail "an active read spans $DISTINCT_SNAPS snapshots"
ok "an active-snapshot read never mixes snapshots ($ACTIVE_VISIBLE row(s), 1 snapshot)"

# Staging remains mutable while STAGING — that is what makes a retry resumable.
run_sql "
UPDATE defense_budget_canonical_row SET text_value='corrected during staging'
 WHERE snapshot_id='$STAGE_SNAP';"
ok "a staging row is still correctable before activation"

# ...and freezes the moment the snapshot leaves STAGING.
run_sql "UPDATE defense_budget_canonical_snapshot SET status='READY', snapshot_hash='$SHA_B'
          WHERE id='$STAGE_SNAP';"
expect_fail "correct a staged row after the snapshot becomes READY" "
UPDATE defense_budget_canonical_row SET text_value='too late'
 WHERE snapshot_id='$STAGE_SNAP';"

# =============================================================================
log "Workstream E: drive a full promotion through the engine"
# =============================================================================
# Everything above exercises the schema with hand-written SQL. This runs the
# real promotion engine and its Prisma adapter, connected as the promoter role,
# so a missing grant or a wrong query fails here rather than in production.

# Give the promoter a password so the engine can authenticate as it. The role
# was created by the migration with an unusable placeholder, exactly as it is in
# a real deployment before bootstrap-roles runs.
run_sql "ALTER ROLE capiro_pe_promoter PASSWORD 'rehearsal-promoter';"
run_sql "GRANT USAGE ON SCHEMA public TO capiro_pe_promoter;"
ok "promoter role given a rehearsal password"

ADMIN_DATABASE_URL="postgresql://$USER_NAME:$PASSWORD@localhost:$PORT/$DB_NAME" \
PROMOTER_DATABASE_URL="postgresql://capiro_pe_promoter:rehearsal-promoter@localhost:$PORT/$DB_NAME" \
  npx tsx "$SCRIPT_DIR/pe-budget-phase7-engine-rehearsal.ts" \
  || fail "the engine rehearsal did not pass"
PASS_COUNT=$((PASS_COUNT + 1))

# =============================================================================
log "Prisma validate/generate against the final schema"
# =============================================================================
(cd "$API_ROOT" && npx prisma validate --schema prisma/schema.prisma >/dev/null) \
  || fail "prisma validate failed"
(cd "$API_ROOT" && npx prisma generate --schema prisma/schema.prisma >/dev/null) \
  || fail "prisma generate failed"
ok "prisma validate and generate succeed"

log "REHEARSAL PASSED — $PASS_COUNT checks. Disposing of the database."
