#!/usr/bin/env bash
# Disposable PostgreSQL 16 proof that the exact-plan execution path is usable
# under the real least-privilege role regardless of main/Phase6 migration order.
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
# does not imply authority to rewrite the verification/projection evidence it
# is authorizing.
for table in \
  defense_budget_promotion_eligibility \
  defense_budget_projection_plan \
  phase6_audit_projection \
  phase6_cycle_certification \
  phase6_cycle_certification_projection; do
  require_false "promoter INSERT $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','INSERT');"
  require_false "promoter DELETE $table" \
    "SELECT has_table_privilege('capiro_pe_promoter','$table','DELETE');"
done

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

echo "Phase 7 exact-plan grant rehearsal PASS"
