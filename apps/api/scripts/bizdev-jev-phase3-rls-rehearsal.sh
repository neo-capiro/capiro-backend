#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal of the Phase 3 BD Jev decision-trace
# tenant isolation contract. Applies ONLY the committed migration chain
# (prisma migrate deploy) to a dedicated throwaway container and proves:
#   - tenant A/B row isolation under RLS via app.current_tenant + SET ROLE
#   - unset-tenant invisibility (fail-closed)
#   - cross-tenant read refusal
#   - cross-tenant write refusal (UPDATE/DELETE of other tenant's row)
#   - allowed own-tenant write
#   - shadow mode refuses visible_effect_jsonb (migration CHECK)
# Never touches capiro-postgres or any pre-existing container; the exact
# dedicated name is refused (reselected with a suffix) if it already exists.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="pgvector/pgvector:pg16"
PORT="${BD_P3_RLS_PG_PORT:-55462}"
BASE_NAME="bd-p3-jev-rls-rehearsal"
DB_NAME="capiro"
TABLE="business_development_jev_decisions"

if docker ps -a --format '{{.Names}}' | grep -qx "$BASE_NAME"; then
  echo "refusing: container '$BASE_NAME' already exists; not removing it" >&2
  NAME="${BASE_NAME}-$RANDOM"
  echo "reselected disposable name: $NAME" >&2
  while docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; do
    NAME="${BASE_NAME}-$RANDOM"
  done
else
  NAME="$BASE_NAME"
fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB="$DB_NAME" \
  -p "$PORT:5432" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U postgres -d "$DB_NAME" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U postgres -d "$DB_NAME" >/dev/null

export DATABASE_URL="postgresql://postgres:postgres@localhost:$PORT/$DB_NAME"
(cd "$API_ROOT" && npx prisma migrate deploy --schema prisma/schema.prisma >/dev/null)

q() { docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "$1"; }
expect_eq() {
  local label="$1" got="$2" want="$3"
  [ "$got" = "$want" ] || { echo "FAILED: $label (got '$got', want '$want')" >&2; exit 1; }
  echo "ok: $label"
}
expect_zero() {
  local label="$1" got="$2"
  [ "$got" = "0" ] || { echo "FAILED: $label (got '$got', want 0)" >&2; exit 1; }
  echo "ok: $label"
}

TENANT_A="00000000-0000-0000-0000-00000000000a"
TENANT_B="00000000-0000-0000-0000-00000000000b"

# RLS + policy actually installed by the committed migration.
expect_eq "RLS enabled" "$(q "SELECT relrowsecurity FROM pg_class WHERE relname='$TABLE';")" "t"
expect_eq "RLS forced"  "$(q "SELECT relforcerowsecurity FROM pg_class WHERE relname='$TABLE';")" "t"
expect_eq "policy present" \
  "$(q "SELECT count(*) FROM pg_policies WHERE tablename='$TABLE' AND policyname='${TABLE}_isolation';")" "1"
expect_eq "capiro_app grant present" \
  "$(q "SELECT has_table_privilege('capiro_app','$TABLE','INSERT');")" "t"

# Seed tenants + one decision row per tenant as postgres (superuser bypasses RLS).
docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" >/dev/null <<SQL
INSERT INTO tenants (id, name, slug) VALUES
  ('$TENANT_A','Phase3 Rehearsal A','phase3-rehearsal-a'),
  ('$TENANT_B','Phase3 Rehearsal B','phase3-rehearsal-b');
INSERT INTO $TABLE (tenant_id, subject_type, subject_id, task, mode, status,
  provider_name, model_version, registry_version, question_version, envelope_hash,
  idempotency_key)
VALUES
  ('$TENANT_A','prospect','seeded-a','bd_entity','shadow','completed',
   'jev:bd_entity','test-model','test-registry','test-question','hash-a','idem-a'),
  ('$TENANT_B','prospect','seeded-b','bd_entity','shadow','completed',
   'jev:bd_entity','test-model','test-registry','test-question','hash-b','idem-b');
SQL

# 1. Tenant A isolation: sees only its own row.
expect_eq "tenant A sees exactly 1 own row" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; SELECT count(*) FROM $TABLE;")" "1"
expect_eq "tenant A row is own subject" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; SELECT subject_id FROM $TABLE;")" "seeded-a"

# 2. Tenant B isolation: sees only its own row.
expect_eq "tenant B sees exactly 1 own row" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SET app.current_tenant='$TENANT_B'; SELECT count(*) FROM $TABLE;")" "1"

# 3. Unset tenant: fail-closed invisibility.
expect_zero "unset tenant sees 0 rows" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SELECT count(*) FROM $TABLE;")"

# 4. Cross-tenant read refusal: A cannot read B's row.
expect_zero "tenant A read of B's subject returns 0 rows" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; SELECT count(*) FROM $TABLE WHERE subject_id='seeded-b';")"

# 5. Cross-tenant write refusal: A's UPDATE targeting B's row affects nothing.
expect_zero "cross-tenant UPDATE affects 0 rows" \
  "$(docker exec -i "$NAME" psql -Atq -U postgres -d "$DB_NAME" <<SQL | tail -n 1
SET ROLE capiro_app;
SET app.current_tenant='$TENANT_A';
WITH s AS (UPDATE $TABLE SET outcome='hijacked' WHERE subject_id='seeded-b' RETURNING 1)
SELECT count(*) FROM s;
SQL
)"
expect_eq "B's row unchanged" \
  "$(q "SELECT outcome FROM $TABLE WHERE subject_id='seeded-b';")" ""

# 5b. Cross-tenant DELETE refusal.
expect_zero "cross-tenant DELETE affects 0 rows" \
  "$(docker exec -i "$NAME" psql -Atq -U postgres -d "$DB_NAME" <<SQL | tail -n 1
SET ROLE capiro_app;
SET app.current_tenant='$TENANT_A';
WITH s AS (DELETE FROM $TABLE WHERE subject_id='seeded-b' RETURNING 1)
SELECT count(*) FROM s;
SQL
)"
expect_eq "B's row still present" "$(q "SELECT count(*) FROM $TABLE WHERE subject_id='seeded-b';")" "1"

# 5c. WITH CHECK: insert stamped with another tenant's id is refused.
if docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" >/dev/null 2>&1 <<SQL
SET ROLE capiro_app;
SET app.current_tenant='$TENANT_A';
INSERT INTO $TABLE (tenant_id, subject_type, subject_id, task, mode, status,
  provider_name, model_version, registry_version, question_version, envelope_hash,
  idempotency_key)
VALUES ('$TENANT_B','prospect','forged-b','bd_entity','shadow','completed',
  'jev:bd_entity','test-model','test-registry','test-question','hash-x','idem-x');
SQL
then
  echo "FAILED: WITH CHECK allowed cross-tenant INSERT" >&2
  exit 1
fi
echo "ok: WITH CHECK refuses cross-tenant INSERT"

# 6. Allowed own-tenant write: A updates and inserts its own rows.
docker exec "$NAME" psql -At -U postgres -d "$DB_NAME" >/dev/null -c \
  "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; UPDATE $TABLE SET outcome='different', review_status='accepted', reviewed_at=now() WHERE subject_id='seeded-a';"
expect_eq "own-tenant UPDATE applied" \
  "$(q "SELECT outcome FROM $TABLE WHERE subject_id='seeded-a';")" "different"
docker exec "$NAME" psql -At -U postgres -d "$DB_NAME" >/dev/null -c \
  "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; INSERT INTO $TABLE (tenant_id, subject_type, subject_id, task, mode, status, provider_name, model_version, registry_version, question_version, envelope_hash, idempotency_key) VALUES ('$TENANT_A','prospect','inserted-a','bd_signal','shadow','completed','jev:bd_signal','test-model','test-registry','test-question','hash-a2','idem-a2');"
expect_eq "own-tenant INSERT visible to A" \
  "$(docker exec "$NAME" psql -Atq -U postgres -d "$DB_NAME" -c "SET ROLE capiro_app; SET app.current_tenant='$TENANT_A'; SELECT count(*) FROM $TABLE;")" "2"

# 7. Shadow mode refuses visible_effect_jsonb (migration CHECK constraint).
if docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U postgres -d "$DB_NAME" >/dev/null 2>&1 <<SQL
SET ROLE capiro_app;
SET app.current_tenant='$TENANT_A';
INSERT INTO $TABLE (tenant_id, subject_type, subject_id, task, mode, status,
  provider_name, model_version, registry_version, question_version, envelope_hash,
  idempotency_key, visible_effect_jsonb)
VALUES ('$TENANT_A','prospect','shadow-effect-a','bd_entity','shadow','completed',
  'jev:bd_entity','test-model','test-registry','test-question','hash-a3','idem-a3',
  '{"any":"visible-effect"}');
SQL
then
  echo "FAILED: shadow row accepted visible_effect_jsonb" >&2
  exit 1
fi
echo "ok: shadow visible_effect_jsonb refused by CHECK"

# 8. Cleanup proof: bypass-free tenant cascade still applies via FK.
q "DELETE FROM tenants WHERE id='$TENANT_A';" >/dev/null
expect_eq "tenant A delete cascades decisions" \
  "$(q "SELECT count(*) FROM $TABLE WHERE tenant_id='$TENANT_A';")" "0"
expect_eq "tenant B rows untouched by A cleanup" \
  "$(q "SELECT count(*) FROM $TABLE WHERE tenant_id='$TENANT_B';")" "1"

docker rm -f "$NAME" >/dev/null
trap - EXIT
echo "BD Phase 3 Jev RLS rehearsal PASS (container removed: $NAME)"