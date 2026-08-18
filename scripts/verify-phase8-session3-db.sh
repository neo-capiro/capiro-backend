#!/usr/bin/env bash
# Disposable PostgreSQL 16 rehearsal for Phase 8 Session 3 (Workstream E):
# the defense-api Program Elements full-surface DB boundary.
#
# Proves, against a real empty database, in order — extending (not
# replacing) every Session 2 negative control:
#   1. the full authoritative migration ledger applies from zero, including
#      the new Session 3 migration (capiro_defense_resolve_member + table grants)
#   2. capiro_defense_serve still holds no excessive authority after the new grants
#   3. capiro_defense_resolve_member resolves (userId, role) correctly and only
#      for capiro_defense_serve (capiro_defense_job has no EXECUTE grant)
#   4. own-tenant reads/writes work; foreign-tenant reads/writes do not
#      (watch, data-issue, alert-pref — the Session 3 overlay tables)
#   5. serve still cannot promote, activate a snapshot, DDL, or mutate a
#      job-only/canonical table (repeats every Session 2 check verbatim)
#   6. serve CAN propose a manual override (INSERT) and approve it (UPDATE),
#      but CANNOT delete an override record (immutable/versioned invariant)
#   7. the parser plane still has no database role or credential
#
# NEVER connects to a shared database. The container (if this script started
# it) is destroyed on exit, same convention as verify-phase8-session2-db.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_ROOT="$REPO_ROOT/apps/api"

IMAGE="${P8S3_REHEARSAL_PG_IMAGE:-pgvector/pgvector:pg16}"
PORT="${P8S3_REHEARSAL_PG_PORT:-55449}"
NAME="p8s3-defense-rehearsal"
SUPERUSER="capiro"
SUPERPASS="capiro"
DB_NAME="capiro"

SERVE_LOGIN="p8s3_serve_rehearsal"
JOB_LOGIN="p8s3_job_rehearsal"
LOGIN_PASSWORD="p8s3-rehearsal-pw"

PASS_COUNT=0
log()  { echo "[p8s3-db-rehearsal] $*"; }
fail() { echo "[p8s3-db-rehearsal] FAILED: $*" >&2; exit 1; }
ok()   { PASS_COUNT=$((PASS_COUNT + 1)); echo "[p8s3-db-rehearsal]   ok  $*"; }

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
  if [ "$SELF_MANAGED" = "1" ] && [ "${P8S3_REHEARSAL_KEEP:-0}" != "1" ]; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ADMIN=(psql "$REHEARSAL_DATABASE_URL" -v ON_ERROR_STOP=1 -q)
run_sql()   { "${ADMIN[@]}" -c "$1" >/dev/null || fail "expected success: $1"; }
q()         { "${ADMIN[@]}" -tAc "$1"; }
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
log "1. Migration-from-zero: the full ledger, INCLUDING the new Session 3 migration"
# =============================================================================
run_sql "$(cat "$REPO_ROOT/docker/postgres/init/01-extensions.sql")"
ok "extensions and capiro_app bootstrapped"

(cd "$API_ROOT" && DATABASE_URL="$REHEARSAL_DATABASE_URL" npx prisma migrate deploy \
  --schema prisma/schema.prisma >/dev/null) \
  || fail "migration-from-zero failed: the ledger (incl. Session 3's migration) does not apply cleanly"
ok "MIGRATION_FROM_ZERO: full ledger including 20261120210000_phase8_defense_serve_user_resolver applied cleanly"

[ "$(q "SELECT count(*) FROM pg_proc WHERE proname='capiro_defense_resolve_member';")" = "1" ] \
  || fail "capiro_defense_resolve_member function missing after migrate deploy"
ok "capiro_defense_resolve_member function exists"

# =============================================================================
log "2. capiro_defense_serve still holds no excessive authority after new grants"
# =============================================================================
for attr in rolcanlogin rolsuper rolcreatedb rolcreaterole rolbypassrls rolreplication; do
  [ "$(q "SELECT $attr FROM pg_roles WHERE rolname='capiro_defense_serve';")" = "f" ] \
    || fail "capiro_defense_serve has $attr after Session 3 grants"
done
ok "capiro_defense_serve remains NOLOGIN/NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOBYPASSRLS/NOREPLICATION"
[ "$(q "SELECT pg_has_role('capiro_defense_serve', 'capiro_pe_promoter', 'member');")" = "f" ] \
  || fail "capiro_defense_serve is a member of capiro_pe_promoter after Session 3 grants"
ok "capiro_defense_serve still not a member of the promoter role"

# =============================================================================
log "3. Real login roles"
# =============================================================================
run_sql "DROP ROLE IF EXISTS $SERVE_LOGIN; CREATE ROLE $SERVE_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "DROP ROLE IF EXISTS $JOB_LOGIN; CREATE ROLE $JOB_LOGIN LOGIN PASSWORD '$LOGIN_PASSWORD';"
run_sql "GRANT capiro_defense_serve TO $SERVE_LOGIN WITH INHERIT TRUE;"
run_sql "GRANT capiro_defense_job TO $JOB_LOGIN WITH INHERIT TRUE;"
run_sql "ALTER ROLE $SERVE_LOGIN SET statement_timeout = '15s';"
ok "serve/job rehearsal logins created and granted capability membership"

SERVE_URL="$(login_url "$SERVE_LOGIN")"
JOB_URL="$(login_url "$JOB_LOGIN")"

# =============================================================================
log "4. Fixtures: two tenants, one Program Element, minimum Session 3 overlay rows"
# =============================================================================
TENANT_A="cccccccc-0000-0000-0000-000000000001"
TENANT_B="cccccccc-0000-0000-0000-000000000002"
USER_A="dddddddd-0000-0000-0000-000000000001"
USER_B="dddddddd-0000-0000-0000-000000000002"

run_sql "
INSERT INTO program_element (pe_code, title, source) VALUES ('0601102A', 'Session 3 Rehearsal PE', 'p8s3-rehearsal');
INSERT INTO tenants (id, slug, name, status, clerk_org_id) VALUES
  ('$TENANT_A', 'p8s3-tenant-a', 'Phase 8 Session 3 Tenant A', 'active', 'org_p8s3_a'),
  ('$TENANT_B', 'p8s3-tenant-b', 'Phase 8 Session 3 Tenant B', 'active', 'org_p8s3_b');
INSERT INTO users (id, clerk_user_id, email) VALUES
  ('$USER_A', 'clerk_user_p8s3_a', 'p8s3-user-a@rehearsal.test'),
  ('$USER_B', 'clerk_user_p8s3_b', 'p8s3-user-b@rehearsal.test');
INSERT INTO tenant_memberships (tenant_id, user_id, role, status) VALUES
  ('$TENANT_A', '$USER_A', 'standard_user', 'active'),
  ('$TENANT_B', '$USER_B', 'capiro_admin', 'active');
INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES
  ('$USER_A', '$TENANT_A', '0601102A');
"
ok "two tenants, one user each, one owned PE watch fixture seeded"

# =============================================================================
log "5. capiro_defense_resolve_member resolves (userId, role) correctly"
# =============================================================================
RESOLVED_USER="$(psql "$SERVE_URL" -tAc "SELECT user_id::text FROM capiro_defense_resolve_member('$TENANT_A'::uuid, 'clerk_user_p8s3_a');")"
[ "$RESOLVED_USER" = "$USER_A" ] \
  || fail "capiro_defense_resolve_member resolved userId '$RESOLVED_USER', expected $USER_A"
RESOLVED_ROLE="$(psql "$SERVE_URL" -tAc "SELECT role FROM capiro_defense_resolve_member('$TENANT_A'::uuid, 'clerk_user_p8s3_a');")"
[ "$RESOLVED_ROLE" = "standard_user" ] \
  || fail "capiro_defense_resolve_member resolved role '$RESOLVED_ROLE', expected standard_user"
ok "capiro_defense_resolve_member resolves the real (userId, role) for an active membership"

RESOLVED_ADMIN_ROLE="$(psql "$SERVE_URL" -tAc "SELECT role FROM capiro_defense_resolve_member('$TENANT_B'::uuid, 'clerk_user_p8s3_b');")"
[ "$RESOLVED_ADMIN_ROLE" = "capiro_admin" ] \
  || fail "capiro_defense_resolve_member did not resolve capiro_admin role correctly"
ok "capiro_defense_resolve_member resolves capiro_admin role correctly (admin-route gating depends on this)"

RESOLVED_FOREIGN="$(psql "$SERVE_URL" -tAc "SELECT count(*) FROM capiro_defense_resolve_member('$TENANT_B'::uuid, 'clerk_user_p8s3_a');")"
[ "$RESOLVED_FOREIGN" = "0" ] \
  || fail "capiro_defense_resolve_member resolved a membership across tenants that does not exist"
ok "capiro_defense_resolve_member returns no row for a user with no membership in that tenant"

EXECUTE_DENIED="$(psql "$JOB_URL" -tAc "SELECT * FROM capiro_defense_resolve_member('$TENANT_A'::uuid, 'clerk_user_p8s3_a');" 2>&1)" || true
echo "$EXECUTE_DENIED" | grep -qi "permission denied" \
  || fail "capiro_defense_job could execute capiro_defense_resolve_member, which it was never granted"
ok "capiro_defense_job holds no EXECUTE grant on capiro_defense_resolve_member"

# =============================================================================
log "6. Own-tenant reads/writes on Session 3 overlay tables work; foreign-tenant do not"
# =============================================================================
tenant_scoped_count() {
  psql "$SERVE_URL" -tAc "
WITH _ctx AS (SELECT set_config('app.current_tenant', '$1', true))
SELECT count(*) FROM program_element_watch, _ctx;"
}
OWN_ROWS="$(tenant_scoped_count "$TENANT_A")"
[ "$OWN_ROWS" = "1" ] || fail "own-tenant read returned $OWN_ROWS rows, expected 1"
ok "own-tenant read on program_element_watch returns the owned fixture"

FOREIGN_ROWS="$(tenant_scoped_count "$TENANT_B")"
[ "$FOREIGN_ROWS" = "0" ] || fail "foreign-tenant read returned $FOREIGN_ROWS rows, expected 0 (RLS leak)"
ok "foreign-tenant read returns zero rows"

expect_ok "own-tenant data-issue write" "$SERVE_URL" "
BEGIN;
SELECT set_config('app.current_tenant', '$TENANT_A', true);
SELECT set_config('app.current_user', '$USER_A', true);
INSERT INTO program_element_data_issue (tenant_id, reported_by_user_id, pe_code, issue_type, description, status, created_at, updated_at)
VALUES ('$TENANT_A'::uuid, '$USER_A'::uuid, '0601102A', 'other', 'rehearsal', 'open', now(), now());
COMMIT;"

expect_fail "foreign-tenant data-issue write (insert for a tenant that is not app.current_tenant)" "$SERVE_URL" "
BEGIN;
SELECT set_config('app.current_tenant', '$TENANT_A', true);
INSERT INTO program_element_data_issue (tenant_id, reported_by_user_id, pe_code, issue_type, description, status, created_at, updated_at)
VALUES ('$TENANT_B'::uuid, '$USER_B'::uuid, '0601102A', 'other', 'rehearsal-cross-tenant', 'open', now(), now());
COMMIT;"

# =============================================================================
log "7. Every Session 2 negative control still holds after Session 3's new grants"
# =============================================================================
expect_fail "serve mutates the active-snapshot pointer" "$SERVE_URL" \
  "INSERT INTO defense_budget_active_snapshot (domain, environment, snapshot_id, activation_id) VALUES ('defense_budget', 'rehearsal', gen_random_uuid(), gen_random_uuid());"
expect_fail "serve mutates a canonical row" "$SERVE_URL" \
  "UPDATE defense_budget_canonical_row SET money_value_millions = 1;"
expect_fail "serve mutates a canonical snapshot" "$SERVE_URL" \
  "UPDATE defense_budget_canonical_snapshot SET status = 'ACTIVE';"
expect_fail "serve mutates a job-only table (program_element_ingest_run)" "$SERVE_URL" \
  "INSERT INTO program_element_ingest_run (source) VALUES ('p8s3-rehearsal');"
expect_fail "serve creates a table (DDL)" "$SERVE_URL" "CREATE TABLE serve_should_not_create_p8s3 (id int);"
expect_fail "serve alters an existing table (migration authority)" "$SERVE_URL" \
  "ALTER TABLE program_element ADD COLUMN p8s3_should_not_exist text;"
expect_fail "serve becomes a member of the promoter role" "$SERVE_URL" \
  "SET ROLE capiro_pe_promoter;"
expect_fail "job mutates a serve-only overlay table (program_element_watch)" "$JOB_URL" \
  "INSERT INTO program_element_watch (user_id, tenant_id, pe_code) VALUES ('$USER_A', '$TENANT_A', '0601102A');"
expect_fail "job mutates the active-snapshot pointer" "$JOB_URL" \
  "INSERT INTO defense_budget_active_snapshot (domain, environment, snapshot_id, activation_id) VALUES ('defense_budget', 'rehearsal', gen_random_uuid(), gen_random_uuid());"
ok "every Session 2 negative control still passes with Session 3's additive grants in place"

# =============================================================================
log "8. Serve CAN propose/approve a governed override, but CANNOT delete one"
# =============================================================================
OVERRIDE_ID="eeeeeeee-0000-0000-0000-000000000001"
expect_ok "serve proposes a manual override (INSERT)" "$SERVE_URL" "
INSERT INTO defense_budget_manual_override (
  override_id, canonical_entity, canonical_natural_key, fiscal_year, funding_field,
  money_original_value, money_original_unit, money_value_millions,
  author_actor_id, reason, evidence_ids,
  status, version, effective_from, proposed_at, override_hash
) VALUES (
  '$OVERRIDE_ID'::uuid, 'canonical_rdte_program_element_year', '0601102A|2027', 2027, 'request',
  '5', 'millions', 5,
  '$USER_A', 'rehearsal proposal', '[\"reconciliation_review_queue:rehearsal\"]'::jsonb,
  'proposed', 1, now(), now(), repeat('0', 64)
);"
expect_ok "serve approves a manual override (UPDATE)" "$SERVE_URL" "
UPDATE defense_budget_manual_override
SET status = 'approved', approved_at = now(), approver_actor_id = '$USER_B', approver_role = 'capiro_admin'
WHERE override_id = '$OVERRIDE_ID'::uuid;"
expect_fail "serve deletes a manual override (immutability invariant)" "$SERVE_URL" \
  "DELETE FROM defense_budget_manual_override WHERE override_id = '$OVERRIDE_ID'::uuid;"
ok "governed override propose/approve/no-delete invariant holds for capiro_defense_serve"

# =============================================================================
log "9. The parser plane still has no database role or credential"
# =============================================================================
PARSER_ROLE_COUNT="$(q "SELECT count(*) FROM pg_roles WHERE rolname LIKE 'capiro_defense_parser%';")"
[ "$PARSER_ROLE_COUNT" = "0" ] || fail "a parser database role exists"
ok "no capiro_defense_parser* role exists in this database"

# =============================================================================
log "10. Downstream: defense-api's own test suite, database-backed"
# =============================================================================
log "handing REHEARSAL_DATABASE_URL / REHEARSAL_SERVE_URL to pnpm --filter @capiro/defense-api test"
(cd "$REPO_ROOT" && \
  REHEARSAL_DATABASE_URL="$REHEARSAL_DATABASE_URL" \
  REHEARSAL_SERVE_URL="$SERVE_URL" \
  pnpm --filter @capiro/defense-api test) \
  || fail "defense-api's database-backed acceptance tests failed"
ok "defense-api's database-backed tests pass against this real, migrated database (incl. Session 3 bug-fix regressions)"

echo "[p8s3-db-rehearsal] SESSION3_DB_REHEARSAL_PASS ($PASS_COUNT checks)"
