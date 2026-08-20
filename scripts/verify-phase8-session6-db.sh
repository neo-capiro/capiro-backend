#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 6 (Workstreams H/I).
# Proves the full migration ledger applies and the database itself refuses any
# attempt to turn inferred/candidate relevance into authoritative allocated dollars.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"
IMAGE="${P8S6_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S6_REHEARSAL_PG_PORT:-55450}"
NAME="p8s6-federal-funding-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"
SERVE_LOGIN="p8s6_serve_rehearsal"
JOB_LOGIN="p8s6_job_rehearsal"
LOGIN_PASSWORD="p8s6-rehearsal-pw"
PASS_COUNT=0
log()  { echo "[p8s6-db-rehearsal] $*"; }
fail() { echo "[p8s6-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s6-db-rehearsal]   ok  $*"; }

SELF_MANAGED=0
if [ -n "${REHEARSAL_DATABASE_URL:-}" ]; then
  log "Using externally supplied REHEARSAL_DATABASE_URL"
else
  SELF_MANAGED=1
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_USER="$SUPERUSER" -e POSTGRES_PASSWORD="$SUPERPASS" -e POSTGRES_DB="$DB_NAME" \
    -p "$PORT:5432" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$NAME" pg_isready -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://$SUPERUSER:$SUPERPASS@localhost:$PORT/$DB_NAME"
fi
cleanup() {
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S6_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
ADMIN=(psql "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q)
run_sql() { "${ADMIN[@]}" -c "$1" >/dev/null || fail "expected success: $1"; }
q()       { "${ADMIN[@]}" -tAc "$1"; }
login_url() {
  REHEARSAL_DATABASE_URL_="$REHEARSAL_DATABASE_URL" node -e '
    const u = new URL(process.env.REHEARSAL_DATABASE_URL_);
    u.username = process.argv[1]; u.password = process.argv[2]; process.stdout.write(u.toString());
  ' "$1" "$LOGIN_PASSWORD"
}
expect_fail() {
  local label="$1" url="$2" sql="$3"
  if psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1; then
    fail "$label — database ACCEPTED a statement it must refuse"
  fi
  ok "$label — refused"
}
expect_ok() {
  local label="$1" url="$2" sql="$3"
  psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1 || fail "$label — database refused expected statement"
  ok "$label"
}

log "1. Apply full authoritative migration ledger"
run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions bootstrapped"
(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed"
ok "full migration ledger including Session 6 applied cleanly"
for t in federal_funding_measure federal_funding_provision federal_funding_allocation; do
  [ "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")" = "1" ] \
    || fail "$t missing"
done
ok "all three Federal Funding Event tables exist"

log "2. Create least-privilege rehearsal logins"
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"
ok "serve/job rehearsal logins created"

log "3. Seed immutable source evidence and a measure/provision through job role"
SOURCE_ID="11111111-1111-4111-8111-111111111111"
run_sql "INSERT INTO source_document (
  id, source_key, fiscal_year, budget_cycle, component, document_type, title,
  source_url, sha256, extraction_method, metadata_jsonb
) VALUES (
  '$SOURCE_ID', 'p8s6-source', 2025, 'reconciliation', NULL, 'public_law',
  'P8S6 source', 'https://www.govinfo.gov/example.pdf', repeat('a',64),
  'structured_import', '{}'::jsonb
);"
MEASURE_KEY="$(printf 'b%.0s' $(seq 1 64))"
PROVISION_KEY="$(printf 'c%.0s' $(seq 1 64))"
EVIDENCE_SHA="$(printf 'd%.0s' $(seq 1 64))"
expect_ok "job creates reconciliation measure" "$JOB_URL" "INSERT INTO federal_funding_measure (
  measure_type,status,authority_type,fiscal_year,legislation_id,public_law_number,title,
  source_document_id,dedup_key
) VALUES ('reconciliation','enacted','mandatory',2025,'H.R. 1','119-21','P8S6 measure','$SOURCE_ID','$MEASURE_KEY');"
MEASURE_ID="$(q "SELECT id FROM federal_funding_measure WHERE dedup_key='$MEASURE_KEY';")"
expect_ok "job creates source-grounded provision" "$JOB_URL" "INSERT INTO federal_funding_provision (
  measure_id,section,agency,stated_amount_usd,purpose_text,source_document_id,source_page,evidence_sha256,dedup_key
) VALUES ('$MEASURE_ID','20005(a)(2)','Department of Defense',1400000000,'sUAS industrial base','$SOURCE_ID',49,'$EVIDENCE_SHA','$PROVISION_KEY');"
PROVISION_ID="$(q "SELECT id FROM federal_funding_provision WHERE dedup_key='$PROVISION_KEY';")"

log "4. Exact account-level statutory allocation is allowed only when verified/evidence-bound"
ALLOC_KEY="$(printf 'e%.0s' $(seq 1 64))"
expect_ok "verified account-level amount accepted" "$JOB_URL" "INSERT INTO federal_funding_allocation (
  provision_id,target_type,target_native_key,allocation_stage,mapping_maturity,review_state,
  authoritative_amount_usd,inferred_relevance,base_request_status,potential_double_count,funding_posture,
  evidence_source_document_id,evidence_page,evidence_sha256,dedup_key
) VALUES ('$PROVISION_ID','appropriation_account','Operation and Maintenance, Defense-Wide','statutory',
  'account_level','verified',4400000000,false,'unknown',true,'one_time','$SOURCE_ID',2,'$EVIDENCE_SHA','$ALLOC_KEY');"

log "5. Negative controls: inferred/candidate facts cannot become exact dollars"
BASE="INSERT INTO federal_funding_allocation (provision_id,target_type,target_native_key,allocation_stage,mapping_maturity,review_state,authoritative_amount_usd,inferred_relevance,base_request_status,potential_double_count,funding_posture,evidence_source_document_id,evidence_page,evidence_sha256,dedup_key) VALUES"
expect_fail "capability inference with authoritative dollars" "$JOB_URL" "$BASE ('$PROVISION_ID','capability','small-uas','statutory','capability_inference','verified',1400000000,true,'unknown',true,'one_time','$SOURCE_ID',49,'$EVIDENCE_SHA','$(printf 'f%.0s' $(seq 1 64))');"
expect_fail "unverified candidate with authoritative dollars" "$JOB_URL" "$BASE ('$PROVISION_ID','appropriation_account','O&M DW','statutory','account_level','candidate',1,false,'unknown',true,'one_time','$SOURCE_ID',49,'$EVIDENCE_SHA','$(printf '1%.0s' $(seq 1 64))');"
expect_fail "unmapped record with target identity" "$JOB_URL" "$BASE ('$PROVISION_ID','federal_program','invented-target','statutory','unmapped','candidate',NULL,false,'unknown',true,'one_time','$SOURCE_ID',49,'$EVIDENCE_SHA','$(printf '2%.0s' $(seq 1 64))');"
expect_fail "obligated stage without obligation reference" "$JOB_URL" "$BASE ('$PROVISION_ID','appropriation_account','O&M DW','obligated','account_level','verified',1,false,'unknown',true,'one_time','$SOURCE_ID',49,'$EVIDENCE_SHA','$(printf '3%.0s' $(seq 1 64))');"
expect_ok "capability relevance candidate with no dollars" "$JOB_URL" "$BASE ('$PROVISION_ID','capability','small-uas','statutory','capability_inference','candidate',NULL,true,'unknown',true,'one_time','$SOURCE_ID',49,'$EVIDENCE_SHA','$(printf '4%.0s' $(seq 1 64))');"

log "6. HTTP serve role is read-only; job role cannot delete source-grounded facts"
expect_ok "serve reads measures" "$SERVE_URL" "SELECT count(*) FROM federal_funding_measure;"
expect_fail "serve cannot insert measures" "$SERVE_URL" "INSERT INTO federal_funding_measure (measure_type,status,authority_type,title,source_document_id,dedup_key) VALUES ('supplemental','draft','discretionary','bad','$SOURCE_ID','$(printf '5%.0s' $(seq 1 64))');"
expect_fail "serve cannot update allocations" "$SERVE_URL" "UPDATE federal_funding_allocation SET authoritative_amount_usd=0;"
expect_fail "job cannot delete allocations" "$JOB_URL" "DELETE FROM federal_funding_allocation;"
ok "role boundary preserves read-only HTTP and immutable job facts"

log "7. Alternative funding did not leak into ProgramElementYear"
LEAKS="$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='program_element_year' AND column_name ~* '(supplement|reconciliation|rescission|reprogram|continuing)';")"
[ "$LEAKS" = "0" ] || fail "alternative funding columns leaked into program_element_year"
ok "ProgramElementYear remains annual-stage only"

log "8. Evidence foreign keys refuse fabricated source ids"
expect_fail "measure without real source_document" "$JOB_URL" "INSERT INTO federal_funding_measure (measure_type,status,authority_type,title,source_document_id,dedup_key) VALUES ('supplemental','draft','discretionary','bad','99999999-9999-4999-8999-999999999999','$(printf '6%.0s' $(seq 1 64))');"

log "SESSION6_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
