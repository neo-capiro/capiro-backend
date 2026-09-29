#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 2 (Workstream C/D):
# the defense-api dark scaffold's database boundary.
#
# Proves, against a real empty database, in order:
#   1. the full authoritative migration ledger applies from zero
#   2. capiro_defense_serve / capiro_defense_job hold no excessive authority
#   3. a real login that only inherits those capability roles is itself safe
#      (role-level ALTER ROLE ... SET does not propagate through membership —
#      the login needs its own matching settings; this rehearsal proves it)
#   4. own-tenant reads/writes work and foreign-tenant reads/writes do not
#   5. serve cannot touch canonical/source/job-only tables; job can mutate
#      only its approved tables; neither can create objects, migrate, promote,
#      or activate a snapshot
#   6. the parser plane holds no database role at all
#   7. the guarded future main-API cutover-revocation script is real and
#      effective, rehearsed only inside this disposable database
#
# NEVER connects to a shared database. The container (if this script started
# it) is destroyed on exit.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"

IMAGE="${P8S2_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S2_REHEARSAL_PG_PORT:-55448}"
NAME="p8s2-defense-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"

SERVE_LOGIN="p8s2_serve_rehearsal"
JOB_LOGIN="p8s2_job_rehearsal"
MAIN_API_LOGIN="p8s2_main_api_rehearsal"
LOGIN_PASSWORD="p8s2-rehearsal-pw"

PASS_COUNT=0
log()  { echo "[p8s2-db-rehearsal] $*"; }
fail() { echo "[p8s2-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s2-db-rehearsal]   ok  $*"; }

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
    # The image's initialization server accepts Unix sockets before restarting.
    # Wait for TCP so migration begins only after the final server is ready.
    docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$SUPERUSER" -d "$DB_NAME" >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready"
  REHEARSAL_DATABASE_URL="postgresql://$SUPERUSER:$SUPERPASS@localhost:$PORT/$DB_NAME"
fi

cleanup() {
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S2_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ADMIN=(psql "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q)
run_sql()   { "${ADMIN[@]}" -c "$1" >/dev/null || fail "expected success: $1"; }
q()         { "${ADMIN[@]}" -tAc "$1"; }
# Build a per-login connection URL by swapping credentials into the admin URL,
# so every check against a login runs over a fresh real connection as that
# login (never SET ROLE from the superuser) -- which is what actually exercises
# role-level ALTER ROLE ... SET session defaults the way a real client would.
login_url() {
  REHEARSAL_DATABASE_URL_="$REHEARSAL_DATABASE_URL" node -e '
    const u = new URL(process.env.REHEARSAL_DATABASE_URL_);
    u.username = process.argv[1];
    u.password = process.argv[2];
    process.stdout.write(u.toString());
  ' "$1" "$LOGIN_PASSWORD"
}
expect_fail() {
  local label="$1"; local url="$2"; local sql="$3"
  if psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1; then
    fail "$label — the database ACCEPTED a statement it must refuse"
  fi
  ok "$label — refused"
}
expect_ok() {
  local label="$1"; local url="$2"; local sql="$3"
  psql "$url" -v ON_ERROR_STOP=1 -tAc "$sql" >/dev/null 2>&1 \
    || fail "$label — the database refused a statement it must accept"
  ok "$label"
}

# =============================================================================
log "1. Migration-from-zero: the full authoritative ledger applies"
# =============================================================================
run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions and capiro_app bootstrapped, matching local dev / CI exactly"

# Only the container created by this invocation receives CI baseline fixtures.
# An externally supplied URL receives no new bootstrap writes.
if [ "$SELF_MANAGED" = "1" ]; then
  fixture_psql() {
    docker exec -i -e PGPASSWORD="$SUPERPASS" -e PGHOSTADDR=127.0.0.1 \
      -e PGSERVICE= -e PGSERVICEFILE= -e PGOPTIONS= "$NAME" \
      psql --no-psqlrc --set=ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 \
      --username="$SUPERUSER" --dbname="$DB_NAME" "$@"
  }
  identity="$(fixture_psql -Atc "SELECT current_database(), current_user, inet_server_port(), current_setting('is_superuser')")"
  [ "$identity" = 'capiro|capiro|5432|on' ] || fail "unexpected owned fixture identity: $identity"
  fixture_psql < "$SCRIPT_DIR/ci/disposable-capiro-worker-prerequisite.sql"
  fixture_psql < "$SCRIPT_DIR/ci/research-portfolio-append-only-prerequisite.sql"
  ok "external baseline role and append-only helper installed in owned disposable container"
fi

(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy \
  --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed: the ledger does not apply cleanly to an empty database"
ok "MIGRATION_FROM_ZERO: the full migration ledger (including the renamed Session 2 migration) applied cleanly"

[ "$(q "SELECT to_regclass('public.defense_budget_active_snapshot') IS NOT NULL;")" = "t" ] \
  || fail "defense_budget_active_snapshot missing after migrate deploy"
[ "$(q "SELECT to_regclass('public.defense_budget_canonical_snapshot') IS NOT NULL;")" = "t" ] \
  || fail "defense_budget_canonical_snapshot missing after migrate deploy"
ok "Phase 7 canonical tables exist, proving the Session 2 migration's dependency ordering is correct"

for role in capiro_defense_serve capiro_defense_job; do
  [ "$(q "SELECT count(*) FROM pg_roles WHERE rolname='$role';")" = "1" ] \
    || fail "$role was not created"
done
ok "capiro_defense_serve and capiro_defense_job exist"

# =============================================================================
log "2. Capability roles hold no excessive authority"
# =============================================================================
for role in capiro_defense_serve capiro_defense_job; do
  for attr in rolcanlogin rolsuper rolcreatedb rolcreaterole rolbypassrls rolreplication; do
    [ "$(q "SELECT $attr FROM pg_roles WHERE rolname='$role';")" = "f" ] \
      || fail "$role has $attr"
  done
done
ok "neither capability role can log in, and neither holds SUPERUSER/CREATEDB/CREATEROLE/BYPASSRLS/REPLICATION"

for role in capiro_defense_serve capiro_defense_job; do
  [ "$(q "SELECT pg_has_role('$role', 'capiro_pe_promoter', 'member');")" = "f" ] \
    || fail "$role is a member of capiro_pe_promoter"
done
ok "neither capability role is a member of the promoter role"

# =============================================================================
log "3. Real login roles, exactly as production membership would grant"
# =============================================================================
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $MAIN_API_LOGIN; CREATE ROLE $MAIN_API_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_app TO $MAIN_API_LOGIN WITH INHERIT TRUE;"
ok "serve/job/main-api rehearsal logins created and granted capability membership with inherit"

# ALTER ROLE ... SET on a NOLOGIN capability role does NOT propagate to a
# member's session: PostgreSQL applies role-specific session defaults only for
# the role actually used to authenticate, not for roles it inherits from. The
# migration's ALTER ROLE capiro_defense_serve SET statement_timeout therefore
# proves nothing about a real connection unless the login itself carries the
# same settings — which is exactly what this step and the assertion below
# prove, and what production's bootstrap-roles process must also do.
run_sql "ALTER ROLE $SERVE_LOGIN SET statement_timeout = '15s';"
run_sql "ALTER ROLE $SERVE_LOGIN SET lock_timeout = '3s';"
run_sql "ALTER ROLE $SERVE_LOGIN SET idle_in_transaction_session_timeout = '15s';"
run_sql "ALTER ROLE $JOB_LOGIN SET statement_timeout = '15min';"

SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"
MAIN_API_URL="$(login_url "$MAIN_API_LOGIN")"

SERVE_TIMEOUT="$(psql "$SERVE_URL" -tAc "SHOW statement_timeout;")"
[ "$SERVE_TIMEOUT" = "15s" ] \
  || fail "a fresh connection as $SERVE_LOGIN does not see statement_timeout=15s (got '$SERVE_TIMEOUT') — inheriting capiro_defense_serve's ALTER ROLE SET is not enough"
ok "TIMEOUT_ON_ACTUAL_LOGIN: a fresh connection as the real login (not SET ROLE) enforces statement_timeout"

# Role safety, from the login's own fresh session — this is exactly what
# HealthService.readiness() checks at runtime, and what /readyz must see.
UNSAFE_COUNT="$(psql "$SERVE_URL" -tAc "
  SELECT count(*) FROM (
    SELECT 1 WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole))
    UNION ALL SELECT 1 WHERE has_schema_privilege(current_user, 'public', 'CREATE')
    UNION ALL SELECT 1 WHERE pg_has_role(current_user, 'capiro_pe_promoter', 'member')
    UNION ALL SELECT 1 WHERE has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'INSERT')
    UNION ALL SELECT 1 WHERE has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'UPDATE')
    UNION ALL SELECT 1 WHERE has_table_privilege(current_user, 'public.defense_budget_active_snapshot', 'DELETE')
  ) unsafe;
")"
[ "$UNSAFE_COUNT" = "0" ] || fail "$SERVE_LOGIN has excessive authority ($UNSAFE_COUNT unsafe condition(s))"
DIRECT_GRANTS="$(psql "$SERVE_URL" -tAc "SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = current_user;")"
[ "$DIRECT_GRANTS" = "0" ] \
  || fail "$SERVE_LOGIN has $DIRECT_GRANTS unexpected direct grant(s) outside the capability boundary"
ok "the real serve login has no excessive authority and no direct grants outside capiro_defense_serve"

# =============================================================================
log "4. Fixtures: two tenants, minimum real Program Elements data"
# =============================================================================
TENANT_A="aaaaaaaa-0000-0000-0000-000000000001"
TENANT_B="aaaaaaaa-0000-0000-0000-000000000002"
USER_A="bbbbbbbb-0000-0000-0000-000000000001"
USER_B="bbbbbbbb-0000-0000-0000-000000000002"

run_sql "
INSERT INTO program_element (pe_code, title, source) VALUES ('0601101A', 'Rehearsal PE', 'p8s2-rehearsal');
INSERT INTO tenants (id, slug, name, status, clerk_org_id) VALUES
  ('$TENANT_A', 'p8s2-tenant-a', 'Phase 8 Session 2 Tenant A', 'active', 'org_p8s2_a'),
  ('$TENANT_B', 'p8s2-tenant-b', 'Phase 8 Session 2 Tenant B', 'active', 'org_p8s2_b');
INSERT INTO users (id, clerk_user_id, email) VALUES
  ('$USER_A', 'clerk_user_p8s2_a', 'p8s2-user-a@rehearsal.test'),
  ('$USER_B', 'clerk_user_p8s2_b', 'p8s2-user-b@rehearsal.test');
INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES
  ('$TENANT_A', '$USER_A', 'standard_user', 'active'),
  ('$TENANT_B', '$USER_B', 'standard_user', 'active');
INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES
  ('$USER_A', '$TENANT_A', '0601101A');
"
ok "two tenants, one user each, one owned PE watch fixture seeded"

# Narrow SECURITY DEFINER tenant-resolution functions, exercised as the real
# serve login (this is what PrismaOrgTenantResolver calls in place of the
# removed withSystem()/app.bypass_rls escape hatch). Reading `tenants` before
# app.current_tenant is set is exactly what FORCE ROW LEVEL SECURITY blocks
# for a direct table grant, so a correct resolution here is the proof these
# functions actually replace the removed bypass rather than just compiling.
RESOLVED_BY_ORG="$(psql "$SERVE_URL" -tAc "SELECT id::text FROM capiro_defense_resolve_tenant_by_clerk_org('org_p8s2_a');")"
[ "$RESOLVED_BY_ORG" = "$TENANT_A" ] \
  || fail "capiro_defense_resolve_tenant_by_clerk_org resolved '$RESOLVED_BY_ORG', expected $TENANT_A"
RESOLVED_BY_ID="$(psql "$SERVE_URL" -tAc "SELECT slug FROM capiro_defense_resolve_tenant_by_id('$TENANT_B'::uuid);")"
[ "$RESOLVED_BY_ID" = "p8s2-tenant-b" ] \
  || fail "capiro_defense_resolve_tenant_by_id resolved slug '$RESOLVED_BY_ID', expected p8s2-tenant-b"
ok "SECURITY DEFINER tenant-by-clerk-org and tenant-by-id functions resolve correctly before app.current_tenant is set"

MEMBERSHIP_OK="$(psql "$SERVE_URL" -tAc "SELECT capiro_defense_has_active_membership('$TENANT_A'::uuid, 'clerk_user_p8s2_a');")"
[ "$MEMBERSHIP_OK" = "t" ] \
  || fail "capiro_defense_has_active_membership did not confirm the real active membership"
MEMBERSHIP_FOREIGN="$(psql "$SERVE_URL" -tAc "SELECT capiro_defense_has_active_membership('$TENANT_B'::uuid, 'clerk_user_p8s2_a');")"
[ "$MEMBERSHIP_FOREIGN" = "f" ] \
  || fail "capiro_defense_has_active_membership confirmed a membership that does not exist"
ok "SECURITY DEFINER tenant/membership functions resolve correctly for capiro_defense_serve, without app.bypass_rls in application code"

EXECUTE_DENIED="$(psql "$JOB_URL" -tAc "SELECT capiro_defense_has_active_membership('$TENANT_A'::uuid, 'clerk_user_p8s2_a');" 2>&1)" || true
echo "$EXECUTE_DENIED" | grep -qi "permission denied" \
  || fail "capiro_defense_job could execute a tenant-resolution function it was never granted"
ok "capiro_defense_job holds no EXECUTE grant on the tenant-resolution functions"

# =============================================================================
log "5. Own-tenant reads/writes work; foreign-tenant reads/writes do not"
# =============================================================================
# A CTE keeps set_config()'s own result out of the printed output: psql -tAc
# prints one line per top-level statement, and set_config is not top-level here.
tenant_scoped_count() {
  psql "$SERVE_URL" -tAc "
WITH _ctx AS (SELECT set_config('app.current_tenant', '$1', true))
SELECT count(*) FROM program_element_watch, _ctx;"
}

OWN_ROWS="$(tenant_scoped_count "$TENANT_A")"
[ "$OWN_ROWS" = "1" ] || fail "own-tenant read returned $OWN_ROWS rows, expected 1"
ok "own-tenant read returns the owned fixture"

FOREIGN_ROWS="$(tenant_scoped_count "$TENANT_B")"
[ "$FOREIGN_ROWS" = "0" ] || fail "foreign-tenant read returned $FOREIGN_ROWS rows, expected 0 (RLS leak)"
ok "foreign-tenant read returns zero rows while the owned fixture exists"

expect_ok "own-tenant overlay write (insert a second owned watch)" "$SERVE_URL" "
BEGIN;
SELECT set_config('app.current_tenant', '$TENANT_A', true);
INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES ('$USER_A', '$TENANT_A', '0601101A') ON CONFLICT DO NOTHING;
COMMIT;"

expect_fail "foreign-tenant overlay write (insert a watch row for a tenant that is not app.current_tenant)" "$SERVE_URL" "
BEGIN;
SELECT set_config('app.current_tenant', '$TENANT_A', true);
INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES ('$USER_B', '$TENANT_B', '0601101A');
COMMIT;"

# =============================================================================
log "6. Serve/job table boundaries; neither can create, migrate, promote, or activate"
# =============================================================================
expect_fail "serve mutates the active-snapshot pointer" "$SERVE_URL" \
  "INSERT INTO defense_budget_active_snapshot (domain, environment, snapshot_id, activation_id) VALUES ('defense_budget', 'rehearsal', gen_random_uuid(), gen_random_uuid());"
expect_fail "serve mutates a canonical row" "$SERVE_URL" \
  "UPDATE defense_budget_canonical_row SET money_value_millions = 1;"
expect_fail "serve mutates a canonical snapshot" "$SERVE_URL" \
  "UPDATE defense_budget_canonical_snapshot SET status = 'ACTIVE';"
expect_fail "serve mutates a job-only table (program_element_ingest_run)" "$SERVE_URL" \
  "INSERT INTO program_element_ingest_run (source) VALUES ('p8s2-rehearsal');"
expect_fail "serve creates a table" "$SERVE_URL" "CREATE TABLE serve_should_not_create (id int);"
expect_fail "serve alters an existing table (migration authority)" "$SERVE_URL" \
  "ALTER TABLE program_element ADD COLUMN p8s2_should_not_exist text;"
expect_fail "serve becomes a member of the promoter role" "$SERVE_URL" \
  "SET ROLE capiro_pe_promoter;"

expect_ok "job mutates its approved ingest table" "$JOB_URL" \
  "INSERT INTO program_element_ingest_run (source) VALUES ('p8s2-rehearsal');"
expect_fail "job mutates a serve-only overlay table (program_element_watch)" "$JOB_URL" \
  "INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES ('$USER_A', '$TENANT_A', '0601101A');"
expect_fail "job mutates a canonical row" "$JOB_URL" \
  "UPDATE defense_budget_canonical_row SET money_value_millions = 1;"
expect_fail "job mutates the active-snapshot pointer" "$JOB_URL" \
  "INSERT INTO defense_budget_active_snapshot (domain, environment, snapshot_id, activation_id) VALUES ('defense_budget', 'rehearsal', gen_random_uuid(), gen_random_uuid());"
expect_fail "job creates a table" "$JOB_URL" "CREATE TABLE job_should_not_create (id int);"
expect_fail "job becomes a member of the promoter role" "$JOB_URL" "SET ROLE capiro_pe_promoter;"

# =============================================================================
log "7. The parser plane has no database role or credential"
# =============================================================================
PARSER_ROLE_COUNT="$(q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'capiro_defense_parser%';")"
[ "$PARSER_ROLE_COUNT" = "0" ] || fail "a parser database role exists"
ok "no capiro_defense_parser* role exists in this database"

# =============================================================================
log "8. Guarded future main-API cutover revocation, rehearsed only here"
# =============================================================================
expect_ok "main-api login can still mutate program_element before cutover" "$MAIN_API_URL" \
  "UPDATE program_element SET title = 'Rehearsal PE (pre-cutover)' WHERE pe_code = '0601101A';"

psql "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
  -v DEFENSE_CUTOVER_APPROVED=YES -v main_api_role=capiro_app \
  -f "$REPO_ROOT/apps/defense-api/sql/cutover-revoke-main-api.sql" >/dev/null \
  || fail "the guarded cutover-revoke script failed to apply in the disposable database"
ok "cutover-revoke-main-api.sql applied (disposable database only — never production)"

expect_fail "main-api login mutates program_element after cutover" "$MAIN_API_URL" \
  "UPDATE program_element SET title = 'Rehearsal PE (post-cutover)' WHERE pe_code = '0601101A';"
expect_ok "main-api login can still SELECT program_element after cutover (reads are not revoked)" "$MAIN_API_URL" \
  "SELECT 1 FROM program_element WHERE pe_code = '0601101A';"

# =============================================================================
log "9. Downstream: defense-api's own test suite, database-backed"
# =============================================================================
log "handing REHEARSAL_DATABASE_URL / REHEARSAL_SERVE_URL to pnpm --filter @capiro/defense-api test"
(cd "$REPO_ROOT" && \
  REHEARSAL_DATABASE_URL="$REHEARSAL_DATABASE_URL" \
  REHEARSAL_SERVE_URL="$SERVE_URL" \
  pnpm --filter @capiro/defense-api test) \
  || fail "defense-api's database-backed acceptance tests failed"
ok "defense-api's /readyz acceptance tests pass against this real, migrated database"

echo "[p8s2-db-rehearsal] SESSION2_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
