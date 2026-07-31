#!/usr/bin/env bash
#
# Phase C disposable-PostgreSQL migration/RLS rehearsal.
#
# Proves the two Phase C migrations behave correctly against a REAL PostgreSQL 16
# instance, including the parts no unit test can cover: that the duplicate
# preflight aborts, that the RLS policy guard refuses to OR-combine with an
# unexpected policy, that a non-owner runtime-like role fails closed without tenant
# context, and that the bypass GUC still grants the cross-tenant reach the PE alert
# fan-out depends on.
#
# NEVER point this at a shared database. It creates and DROPS its own database.
#
# Usage:
#   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres PGPASSWORD=... \
#     bash apps/api/scripts/pe-phase-c-rls-rehearsal.sh
#
# Optional: PGBIN=/path/to/postgres/bin (when psql is not on PATH).
# Run from the repository root.

set -euo pipefail

PGBIN="${PGBIN:-}"
PSQL_BIN="psql"
if [ -n "$PGBIN" ]; then PSQL_BIN="$PGBIN/psql"; fi

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGUSER="${PGUSER:-postgres}"
DB="${PHASE_C_DB:-phase_c_rehearsal}"
APP_ROLE=phase_c_app
APP_PW=phase_c

export PGHOST PGPORT PGUSER

# Soft env skip when host psql is unavailable (Phase 9 residual). Container paths
# cover forced RLS elsewhere; this rehearsal is host-psql-oriented and optional
# under verify:pe-phase-9 (required:false). Exit 0 with loud skip marker so the
# orchestrator does not treat missing PATH tools as a hard red.
if ! command -v "$PSQL_BIN" >/dev/null 2>&1 && [ ! -x "$PSQL_BIN" ]; then
  echo "PE_PHASE_C_RLS_REHEARSAL_SKIP: host psql not on PATH (PSQL_BIN=$PSQL_BIN PGBIN=${PGBIN:-})"
  echo "Hint: install client tools or set PGBIN=/path/to/postgres/bin; Phase C unit + disposable migrate FORCE RLS remain authoritative."
  exit 0
fi

MIG=apps/api/prisma/migrations
WATCH_MIG="$MIG/20260528112943_add_program_element_watch/migration.sql"
EXPAND_MIG="$MIG/20260728230000_add_tenant_scoped_pe_watch_key/migration.sql"
RLS_MIG="$MIG/20260728230100_enable_program_element_watch_rls/migration.sql"

for f in "$WATCH_MIG" "$EXPAND_MIG" "$RLS_MIG"; do
  [ -f "$f" ] || { echo "FATAL: missing migration $f (run from repo root)" >&2; exit 1; }
done

TENANT_A='00000000-0000-0000-0000-000000000001'
TENANT_B='00000000-0000-0000-0000-000000000003'
USER_ID='00000000-0000-0000-0000-000000000002'
PE='0603270A'

# Superuser/owner session.
adm() { "$PSQL_BIN" -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
# Runtime-like NON-OWNER role — the role whose behaviour actually matters.
app() { PGPASSWORD="$APP_PW" "$PSQL_BIN" -U "$APP_ROLE" -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }

PASSES=0
ok()   { PASSES=$((PASSES+1)); echo "  PASS  $1"; }
fail() { echo "  FAIL  $1" >&2; exit 1; }
eq()   { [ "$2" = "$3" ] && ok "$1 ($2)" || fail "$1: expected '$3', got '$2'"; }

echo "== Phase C RLS rehearsal on $PGHOST:$PGPORT db=$DB =="

"$PSQL_BIN" -d postgres -v ON_ERROR_STOP=1 -qAtc "DROP DATABASE IF EXISTS \"$DB\";" >/dev/null
"$PSQL_BIN" -d postgres -v ON_ERROR_STOP=1 -qAtc "CREATE DATABASE \"$DB\";" >/dev/null

# ── Tenancy helpers + FK parents, mirroring the init tenancy migration ──────────
adm >/dev/null <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS UUID AS \$\$
DECLARE v_raw TEXT := current_setting('app.current_tenant', true);
BEGIN
  IF v_raw IS NULL OR v_raw = '' THEN RETURN NULL; END IF;
  RETURN v_raw::uuid;
EXCEPTION WHEN invalid_text_representation THEN RETURN NULL;
END; \$\$ LANGUAGE plpgsql STABLE;

CREATE OR REPLACE FUNCTION rls_bypass() RETURNS BOOLEAN AS \$\$
BEGIN RETURN current_setting('app.bypass_rls', true) = 'on'; END;
\$\$ LANGUAGE plpgsql STABLE;

CREATE TABLE "users" ("id" UUID PRIMARY KEY);
CREATE TABLE "tenants" ("id" UUID PRIMARY KEY);
CREATE TABLE "program_element" ("pe_code" VARCHAR(16) PRIMARY KEY);
INSERT INTO "tenants" ("id") VALUES ('$TENANT_A'), ('$TENANT_B');
INSERT INTO "users" ("id") VALUES ('$USER_ID');
-- 0603271A is a SECOND PE, used only by the bypass fan-out check so it can put two
-- different tenants in the table while the legacy (user_id, pe_code) key still exists.
INSERT INTO "program_element" ("pe_code") VALUES ('$PE'), ('0603271A');

DROP ROLE IF EXISTS $APP_ROLE;
CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PW';
SQL

# 1. Legacy starting state.
adm -f "$WATCH_MIG" >/dev/null
ok "1. original watch table creates in the legacy state"

# 2. Duplicate tenant/user/PE rows abort the expand migration.
adm -c 'DROP INDEX "program_element_watch_user_pe_code_key";' >/dev/null
adm -c "INSERT INTO program_element_watch (tenant_id, user_id, pe_code)
        VALUES ('$TENANT_A','$USER_ID','$PE'), ('$TENANT_A','$USER_ID','$PE');" >/dev/null
if adm -f "$EXPAND_MIG" >/tmp/pc-dup.log 2>&1; then
  fail "2. duplicate preflight should have aborted"
fi
grep -q 'duplicate tenant/user/PE rows' /tmp/pc-dup.log \
  && ok "2. duplicate preflight aborts with the intended message" \
  || fail "2. aborted for the wrong reason: $(tail -1 /tmp/pc-dup.log)"

# 3-5. Clean data expands; both keys coexist.
adm -c 'DROP TABLE "program_element_watch" CASCADE;' >/dev/null
adm -f "$WATCH_MIG" >/dev/null
adm -f "$EXPAND_MIG" >/dev/null
ok "3. clean data allows the tenant-aware index to be created"
eq "4. legacy index still exists after expansion" \
  "$(adm -c "SELECT COUNT(*) FROM pg_indexes WHERE indexname='program_element_watch_user_pe_code_key';")" 1
eq "5. tenant-aware index exists after expansion" \
  "$(adm -c "SELECT COUNT(*) FROM pg_indexes WHERE indexname='program_element_watch_tenant_user_pe_code_key';")" 1

# 6. An unexpected pre-existing policy must abort the RLS migration.
adm -c 'CREATE POLICY "unexpected_policy" ON "program_element_watch" USING (true) WITH CHECK (true);' >/dev/null
if adm -f "$RLS_MIG" >/tmp/pc-pol.log 2>&1; then
  fail "6. unexpected-policy guard should have aborted"
fi
grep -q 'already has an RLS policy' /tmp/pc-pol.log \
  && ok "6. unexpected existing policy aborts the RLS migration" \
  || fail "6. aborted for the wrong reason: $(tail -1 /tmp/pc-pol.log)"

# 7. Canonical migration succeeds once the unexpected policy is gone.
adm -c 'DROP POLICY "unexpected_policy" ON "program_element_watch";' >/dev/null
adm -f "$RLS_MIG" >/dev/null
ok "7. canonical RLS migration succeeds after the unexpected policy is removed"

# Runtime-role privileges, matching the tenancy migration's grant convention.
adm >/dev/null <<SQL
GRANT USAGE ON SCHEMA public TO $APP_ROLE;
GRANT SELECT, INSERT, UPDATE, DELETE ON "program_element_watch" TO $APP_ROLE;
SQL

# 8-9. RLS enabled AND forced, with exactly one policy.
eq "8. RLS is enabled and forced" \
  "$(adm -c "SELECT relrowsecurity::int + relforcerowsecurity::int FROM pg_class WHERE oid='program_element_watch'::regclass;")" 2
eq "9. exactly the reviewed intended policy exists" \
  "$(adm -c "SELECT COUNT(*) FROM pg_policies WHERE tablename='program_element_watch' AND policyname='program_element_watch_isolation';")" 1
eq "9b. no other policy exists on the table" \
  "$(adm -c "SELECT COUNT(*) FROM pg_policies WHERE tablename='program_element_watch';")" 1

# 10. No tenant context → zero rows for the runtime-like role.
adm -c "INSERT INTO program_element_watch (tenant_id, user_id, pe_code) VALUES ('$TENANT_A','$USER_ID','$PE');" >/dev/null
eq "10. runtime role with NO tenant context sees zero rows" \
  "$(app -c 'SELECT COUNT(*) FROM program_element_watch;')" 0
adm -c 'TRUNCATE program_element_watch;' >/dev/null

# 11. Tenant A can insert and read its own row.
eq "11. tenant A can insert and read tenant A's row" \
  "$(app -c "SET app.current_tenant='$TENANT_A';
             INSERT INTO program_element_watch (tenant_id,user_id,pe_code) VALUES ('$TENANT_A','$USER_ID','$PE');
             SELECT COUNT(*) FROM program_element_watch;")" 1

# 12. Tenant A cannot insert a tenant B row (WITH CHECK).
if app -c "SET app.current_tenant='$TENANT_A';
           INSERT INTO program_element_watch (tenant_id,user_id,pe_code) VALUES ('$TENANT_B','$USER_ID','$PE');" \
     >/tmp/pc-deny.log 2>&1; then
  fail "12. cross-tenant insert should have been denied"
fi
grep -q 'violates row-level security policy' /tmp/pc-deny.log \
  && ok "12. tenant A cannot insert tenant B's row (WITH CHECK denies)" \
  || fail "12. denied for the wrong reason: $(tail -1 /tmp/pc-deny.log)"

# 13-14. Legacy key blocks tenant B during coexistence, and A's row is untouched.
if app -c "SET app.current_tenant='$TENANT_B';
           INSERT INTO program_element_watch (tenant_id,user_id,pe_code) VALUES ('$TENANT_B','$USER_ID','$PE');" \
     >/tmp/pc-legacy.log 2>&1; then
  fail "13. legacy key should have blocked tenant B's same user+PE insert"
fi
grep -q 'program_element_watch_user_pe_code_key' /tmp/pc-legacy.log \
  && ok "13. legacy key blocks tenant B's same user+PE insert during coexistence" \
  || fail "13. blocked for the wrong reason: $(tail -1 /tmp/pc-legacy.log)"
eq "14a. tenant A's row was not moved or modified" \
  "$(adm -c "SELECT COUNT(*) FROM program_element_watch WHERE tenant_id='$TENANT_A';")" 1
eq "14b. no tenant B row was created" \
  "$(adm -c "SELECT COUNT(*) FROM program_element_watch WHERE tenant_id='$TENANT_B';")" 0

# 19. THE ALERT FAN-OUT MECHANISM. Cross-tenant enumeration is what
# DeltaEngineService.getAffectedTenants, ProgramElementWriterService.getAffectedTenants,
# BillPeExtractorService.maybeEmit and send-pe-alert-emails all depend on. Under the
# policy that reach exists ONLY via the bypass GUC that PrismaService.withSystem sets.
# Without it the read returns zero rows and every one of those callers silently decides
# "no tenant watches this PE". Prove both halves on the same role and connection.
adm -c "INSERT INTO program_element_watch (tenant_id,user_id,pe_code)
        VALUES ('$TENANT_B','$USER_ID','0603271A');" >/dev/null
eq "19a. bypass GUC ('on') restores full cross-tenant fan-out reach" \
  "$(app -c "SELECT set_config('app.bypass_rls','on',false); SELECT COUNT(DISTINCT tenant_id) FROM program_element_watch;" | tail -1)" 2
eq "19b. WITHOUT the bypass GUC the same fan-out read returns zero rows, no error" \
  "$(app -c 'SELECT COUNT(*) FROM program_element_watch;')" 0
adm -c "DELETE FROM program_element_watch WHERE pe_code='0603271A';" >/dev/null

# 15-18. TEST-ONLY contract simulation: drop ONLY the legacy key.
adm -c 'DROP INDEX "program_element_watch_user_pe_code_key";' >/dev/null
app -c "SET app.current_tenant='$TENANT_B';
        INSERT INTO program_element_watch (tenant_id,user_id,pe_code) VALUES ('$TENANT_B','$USER_ID','$PE');" >/dev/null
eq "15. after dropping only the legacy key, both tenant rows coexist" \
  "$(adm -c 'SELECT COUNT(*) FROM program_element_watch;')" 2
eq "16. tenant A sees only tenant A's row" \
  "$(app -c "SET app.current_tenant='$TENANT_A'; SELECT COUNT(*) FROM program_element_watch;")" 1
eq "17. tenant B sees only tenant B's row" \
  "$(app -c "SET app.current_tenant='$TENANT_B'; SELECT COUNT(*) FROM program_element_watch;")" 1
app -c "SET app.current_tenant='$TENANT_B';
        DELETE FROM program_element_watch WHERE tenant_id='$TENANT_A' AND user_id='$USER_ID' AND pe_code='$PE';" >/dev/null
eq "18a. tenant B cannot delete tenant A's row" \
  "$(adm -c "SELECT COUNT(*) FROM program_element_watch WHERE tenant_id='$TENANT_A';")" 1
eq "18b. tenant B's own row is still present" \
  "$(adm -c "SELECT COUNT(*) FROM program_element_watch WHERE tenant_id='$TENANT_B';")" 1

"$PSQL_BIN" -d postgres -v ON_ERROR_STOP=1 -qAtc "DROP DATABASE IF EXISTS \"$DB\";" >/dev/null
echo "== Phase C RLS rehearsal: $PASSES checks PASSED; disposable database dropped =="
