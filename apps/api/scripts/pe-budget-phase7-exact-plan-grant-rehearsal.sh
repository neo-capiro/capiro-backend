#!/usr/bin/env bash
# Disposable PostgreSQL 16 proof that the exact-plan execution path is usable
# under the real least-privilege roles regardless of main/Phase6 migration order.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${P7_EXACT_GRANT_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P7_EXACT_GRANT_PG_PORT:-55449}"
NAME="pe-p7-exact-grant-rehearsal"
PASSWORD="postgres"
DB_NAME="capiro"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$PASSWORD" \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d "$DB_NAME" >/dev/null

export DATABASE_URL="postgresql://postgres:$PASSWORD@localhost:$PORT/$DB_NAME"
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)

# Apply the independent Phase 6 migration chain after the main chain. This is
# the ordering that used to leave the promoter without SELECT on Phase 6 rows.
for migration in "$API_ROOT"/prisma/phase6-projection/migrations/*/migration.sql; do
  docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" < "$migration" >/dev/null
done

q() { docker exec "$NAME" psql -At -U postgres -d "$DB_NAME" -c "$1"; }
require_true() {
  local label="$1"; local sql="$2"
  [ "$(q "$sql")" = "t" ] || { echo "FAILED: $label" >&2; exit 1; }
  echo "ok: $label"
}
require_false() {
  local label="$1"; local sql="$2"
  [ "$(q "$sql")" = "f" ] || { echo "FAILED: $label" >&2; exit 1; }
  echo "ok: $label"
}

for table in \
  defense_budget_promotion_eligibility \
  defense_budget_projection_plan \
  phase6_audit_projection \
  phase6_cycle_certification \
  phase6_cycle_certification_projection; do
  require_true "promoter SELECT $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','SELECT');"
done

# Exact-plan evidence is read-only to the promoter. Canonical write authority
# does not imply authority to rewrite verification/projection evidence.
for table in \
  defense_budget_promotion_eligibility \
  defense_budget_projection_plan \
  phase6_audit_projection \
  phase6_cycle_certification \
  phase6_cycle_certification_projection; do
  require_false "promoter INSERT $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','INSERT');"
  require_false "promoter UPDATE $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','UPDATE');"
  require_false "promoter DELETE $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','DELETE');"
done

# Phase 6 audit persistence needs exactly SELECT+INSERT on the new association
# under the serve role. Existing bindings are immutable and cannot be rewritten
# or removed by capiro_app.
require_true "serve SELECT phase6 binding" \
  "SELECT has_table_privilege('capiro_app','phase6_cycle_certification_projection','SELECT');"
require_true "serve INSERT phase6 binding" \
  "SELECT has_table_privilege('capiro_app','phase6_cycle_certification_projection','INSERT');"
require_false "serve UPDATE phase6 binding" \
  "SELECT has_table_privilege('capiro_app','phase6_cycle_certification_projection','UPDATE');"
require_false "serve DELETE phase6 binding" \
  "SELECT has_table_privilege('capiro_app','phase6_cycle_certification_projection','DELETE');"
require_false "serve TRUNCATE phase6 binding" \
  "SELECT has_table_privilege('capiro_app','phase6_cycle_certification_projection','TRUNCATE');"

# Prove the SELECTs execute under SET ROLE rather than merely trusting ACL
# introspection. Empty tables are expected and still prove privilege reach.
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" <<'SQL' >/dev/null
SET ROLE capiro_pe_promoter;
SELECT count(*) FROM defense_budget_promotion_eligibility;
SELECT count(*) FROM defense_budget_projection_plan;
SELECT count(*) FROM phase6_audit_projection;
SELECT count(*) FROM phase6_cycle_certification;
SELECT count(*) FROM phase6_cycle_certification_projection;
RESET ROLE;
SQL

# Prove the serve role can INSERT a real immutable binding and then cannot
# mutate it. Seed the parent rows as postgres so this block tests permissions,
# not unrelated Phase 6 write grants.
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" <<'SQL' >/dev/null
INSERT INTO phase6_audit_projection(
  projection_id,natural_key,idempotency_key,projection_kind,
  verification_candidate_id,verification_run_id,artifact_id,
  artifact_content_sha256,source_document_id,source_pdf_sha256,
  source_profile_hash,native_identity_hash,track,stage,funding_field,
  original_value,original_unit,amount_millions,direct_or_derived,
  evidence_ids_jsonb,binding_status,projection_status,payload_jsonb
) VALUES (
  'grant-p1','grant-nk1','grant-idem1','stage_position',
  'vc','vr','artifact',repeat('a',64),'doc',repeat('b',64),
  repeat('c',64),repeat('d',64),'appropriations','hac_d','hacDMark',
  '1','millions',1,'direct','[]','accepted','verified','{}'
);
INSERT INTO phase6_cycle_certification(
  cycle_id,fiscal_year,manifest_hash,content_sha256,status,
  projection_set_sha256,projection_count,report_jsonb
) VALUES (
  'grant-cycle',2027,repeat('a',64),repeat('e',64),'CERTIFIED',
  repeat('f',64),1,
  jsonb_build_object('projectionSetSha256',repeat('f',64),'projectionCount',1)
);
SET ROLE capiro_app;
INSERT INTO phase6_cycle_certification_projection(
  certification_content_sha256,projection_id,projection_ordinal
) VALUES (repeat('e',64),'grant-p1',0);
RESET ROLE;
SQL

if docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" <<'SQL' >/dev/null 2>&1
SET ROLE capiro_app;
UPDATE phase6_cycle_certification_projection
SET projection_ordinal=1
WHERE projection_id='grant-p1';
SQL
then
  echo "FAILED: capiro_app updated immutable Phase 6 binding" >&2
  exit 1
fi

if docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" <<'SQL' >/dev/null 2>&1
SET ROLE capiro_app;
DELETE FROM phase6_cycle_certification_projection WHERE projection_id='grant-p1';
SQL
then
  echo "FAILED: capiro_app deleted immutable Phase 6 binding" >&2
  exit 1
fi

[ "$(q "SELECT count(*) FROM phase6_cycle_certification_projection WHERE projection_id='grant-p1'")" = "1" ] || {
  echo "FAILED: immutable Phase 6 binding did not survive denied mutations" >&2
  exit 1
}

echo "Phase 7 exact-plan grant rehearsal PASS"
