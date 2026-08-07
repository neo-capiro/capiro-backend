#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION_ROOT="$ROOT/prisma/phase6-projection/migrations"
mapfile -t MIGRATIONS < <(find "$MIGRATION_ROOT" -mindepth 2 -maxdepth 2 -name migration.sql -print | sort)
if [[ ${#MIGRATIONS[@]} -eq 0 ]]; then
  echo "no Phase 6 projection migrations found" >&2
  exit 1
fi

NAME="capiro-phase6-projection-$RANDOM-$$"
PASSWORD="phase6-rehearsal"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --rm --name "$NAME" -e POSTGRES_PASSWORD="$PASSWORD" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres >/dev/null

docker exec "$NAME" createdb -U postgres phase6_fresh
docker exec "$NAME" createdb -U postgres phase6_upgrade

apply_migrations() {
  local db="$1"
  for migration in "${MIGRATIONS[@]}"; do
    docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$db" < "$migration" >/dev/null
  done
}

apply_migrations phase6_fresh
apply_migrations phase6_fresh

docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d phase6_upgrade -c \
  "CREATE TABLE phase5_projection_sentinel(id int primary key, value text); INSERT INTO phase5_projection_sentinel VALUES (1,'keep');" >/dev/null
apply_migrations phase6_upgrade
[[ "$(docker exec "$NAME" psql -At -U postgres -d phase6_upgrade -c "SELECT value FROM phase5_projection_sentinel WHERE id=1")" == "keep" ]]

psql_fresh() { docker exec "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d phase6_fresh "$@"; }
expect_fail() {
  local label="$1"; local sql="$2"
  if psql_fresh -c "$sql" >/dev/null 2>&1; then
    echo "EXPECTED FAILURE DID NOT OCCUR [$label]: $sql" >&2
    exit 1
  fi
}

COLS="projection_id,natural_key,idempotency_key,projection_kind,verification_candidate_id,verification_run_id,artifact_id,artifact_content_sha256,source_document_id,source_pdf_sha256,source_profile_hash,native_identity_hash,track,stage,funding_field,original_value,original_unit,amount_millions,direct_or_derived,evidence_ids_jsonb,binding_status,projection_status,enactment_proof_id,supersedes_projection_id,payload_jsonb"

psql_fresh -c "INSERT INTO phase6_audit_projection($COLS) VALUES ('p1','nk1','idem1','stage_position','vc1','vr1','a1',repeat('a',64),'doc1',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','hac_d','hacDMark','125','millions',125,'direct','[\"e1\"]','accepted','verified',NULL,NULL,'{}')" >/dev/null

expect_fail "track-stage" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p2','nk2','idem2','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'authorization','hac_d','hacDMark','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{}')"
expect_fail "stage-field" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p3','nk3','idem3','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','hac_d','sacDMark','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{}')"
expect_fail "enacted-proof" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p4','nk4','idem4','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','public_law','enacted','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{}')"
expect_fail "verified-binding" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p5','nk5','idem5','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','hac_d','hacDMark','1','millions',1,'direct','[]','candidate','verified',NULL,NULL,'{}')"
expect_fail "live-natural-key" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p6','nk1','idem6','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','hac_d','hacDMark','2','millions',2,'direct','[]','accepted','candidate',NULL,NULL,'{}')"
expect_fail "cr-line-authority" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p7','nk7','idem7','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','continuing_resolution','enacted','1','millions',1,'direct','[]','accepted','verified','proof7',NULL,'{}')"
expect_fail "reprogramming-basis-missing" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p8','nk8','idem8','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'post_enactment','reprogramming','reprogrammed','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{}')"
expect_fail "execution-metadata-missing" "INSERT INTO phase6_audit_projection($COLS) VALUES ('p9','nk9','idem9','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'post_enactment','execution','executed','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{\"executionMetric\":\"obligations\"}')"
expect_fail "immutable-proof" "UPDATE phase6_audit_projection SET source_pdf_sha256=repeat('f',64) WHERE projection_id='p1'"
expect_fail "immutable-supersedes" "UPDATE phase6_audit_projection SET supersedes_projection_id='other' WHERE projection_id='p1'"
expect_fail "projection-delete" "DELETE FROM phase6_audit_projection WHERE projection_id='p1'"

psql_fresh -c "UPDATE phase6_audit_projection SET projection_status='superseded' WHERE projection_id='p1'" >/dev/null
[[ "$(psql_fresh -At -c "SELECT projection_status FROM phase6_audit_projection WHERE projection_id='p1'")" == "superseded" ]]

psql_fresh -c "INSERT INTO phase6_audit_projection($COLS) VALUES ('cr-ok','cr-ok','cr-ok','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','continuing_resolution','enacted','1','millions',1,'direct','[]','accepted','verified','proof-cr',NULL,'{\"explicitLineAuthority\":true}')" >/dev/null
psql_fresh -c "INSERT INTO phase6_audit_projection($COLS) VALUES ('rp-ok','rp-ok','rp-ok','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'post_enactment','reprogramming','reprogrammed','1','millions',1,'derived','[]','accepted','verified',NULL,NULL,'{\"revisedTotalBasis\":\"policy_derived\"}')" >/dev/null
psql_fresh -c "INSERT INTO phase6_audit_projection($COLS) VALUES ('ex-ok','ex-ok','ex-ok','stage_position','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'post_enactment','execution','executed','1','millions',1,'direct','[]','accepted','verified',NULL,NULL,'{\"executionMetric\":\"obligations\",\"asOfDate\":\"2027-12-31\",\"cumulative\":true}')" >/dev/null

psql_fresh -c "BEGIN; INSERT INTO phase6_audit_projection($COLS) VALUES ('rollback-probe','rollback-probe','rollback-probe','native_line_binding','vc','vr','a',repeat('a',64),'doc',repeat('b',64),repeat('c',64),repeat('d',64),'appropriations','hac_d',NULL,NULL,NULL,NULL,'not_applicable','[]','accepted','candidate',NULL,NULL,'{}'); ROLLBACK;" >/dev/null
[[ "$(psql_fresh -At -c "SELECT count(*) FROM phase6_audit_projection WHERE projection_id='rollback-probe'")" == "0" ]]

psql_fresh -c "INSERT INTO phase6_cycle_certification(cycle_id,fiscal_year,manifest_hash,content_sha256,status,report_jsonb) VALUES ('fy2027',2027,repeat('a',64),repeat('b',64),'CERTIFIED','{}')" >/dev/null
expect_fail "certification-idempotency" "INSERT INTO phase6_cycle_certification(cycle_id,fiscal_year,manifest_hash,content_sha256,status,report_jsonb) VALUES ('fy2027',2027,repeat('a',64),repeat('b',64),'CERTIFIED','{}')"
expect_fail "certification-update" "UPDATE phase6_cycle_certification SET status='REJECTED' WHERE cycle_id='fy2027'"
expect_fail "certification-delete" "DELETE FROM phase6_cycle_certification WHERE cycle_id='fy2027'"

echo "Phase 6 projection rehearsal PASS: all migrations + replay + upgrade + terminal constraints + immutable audit lineage + rollback + idempotency"
