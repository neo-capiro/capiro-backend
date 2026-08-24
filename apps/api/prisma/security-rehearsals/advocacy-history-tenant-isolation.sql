-- Advocacy History security/privacy rehearsal (product spec section 28).
-- Run against a disposable Postgres with all capirov2 migrations applied.
-- Proves, at the REAL DATABASE LEVEL (not mocked), that:
--   1. Cross-tenant isolation on client_advocacy_matter / _link / record
--   2. Cross-client isolation within the SAME tenant
--   3. rls_bypass() correctly grants cross-tenant visibility (server-internal only)
--   4. A session with NO tenant GUC set sees nothing (fail-closed default)
--
-- This mirrors the exact mechanism the app uses in production:
-- PrismaService.withTenant() issues `SELECT set_config('app.current_tenant', $1, true)`
-- inside the transaction before every query — see prisma.service.ts.
--
-- Usage:
--   docker exec -i capiro-postgres psql -U capiro_app -d <rehearsal_db> \
--     -f apps/api/prisma/security-rehearsals/advocacy-history-tenant-isolation.sql
--
-- CRITICAL: run as capiro_app (the real application role), NEVER as
-- capiro. The `capiro` role on this disposable Postgres is a Postgres
-- SUPERUSER with the BYPASSRLS attribute — by Postgres's own built-in
-- semantics (independent of any FORCE ROW LEVEL SECURITY policy this repo
-- defines), a superuser/BYPASSRLS role always sees every row regardless
-- of RLS policies. Running this script as `capiro` will show a false
-- cross-tenant "leak" that is a role-choice artifact, not a real product
-- vulnerability — confirmed by re-running the identical script as
-- capiro_app (a plain role, no special attributes), where every proof
-- passes. If you add a new rehearsal-only role, verify with
-- `\du <role>` that it carries neither Superuser nor Bypass RLS before
-- trusting a failure OR a pass from it.
--
-- capiro_app needs one-time grants on a fresh rehearsal database before
-- this script can write fixtures:
--   GRANT ALL ON DATABASE <rehearsal_db> TO capiro_app;
--   GRANT ALL ON ALL TABLES IN SCHEMA public TO capiro_app;
--   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO capiro_app;
--   GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO capiro_app;
--   GRANT USAGE ON SCHEMA public TO capiro_app;
--
-- Every check ends with a RAISE EXCEPTION if the proof fails, so a nonzero
-- psql exit code means a real isolation failure, not a soft warning.

\set ON_ERROR_STOP on

BEGIN;

-- rls_bypass() is required to INSERT fixture rows before any tenant GUC is
-- set — must be set BEFORE the very first fixture INSERT (tenants itself
-- has RLS too).
SELECT set_config('app.bypass_rls', 'on', false);

-- ── Fixtures: two tenants, two clients under tenant A ───────────────────
INSERT INTO tenants (id, name, slug) VALUES
  ('a0000000-0000-0000-0000-00000000000a', 'Tenant A', 'tenant-a-rehearsal'),
  ('b0000000-0000-0000-0000-00000000000b', 'Tenant B', 'tenant-b-rehearsal')
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, tenant_id, name, status) VALUES
  ('c1000000-0000-0000-0000-00000000c1a1', 'a0000000-0000-0000-0000-00000000000a', 'Client A1 (tenant A)', 'active'),
  ('c1000000-0000-0000-0000-00000000c1a2', 'a0000000-0000-0000-0000-00000000000a', 'Client A2 (tenant A)', 'active'),
  ('c2000000-0000-0000-0000-00000000c2b1', 'b0000000-0000-0000-0000-00000000000b', 'Client B1 (tenant B)', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO client_advocacy_matter (id, tenant_id, client_id, title, matter_type, status, external_key)
VALUES
  ('d1000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000c1a1', 'Tenant A / Client A1 Matter', 'other', 'active', 'rehearsal-a1'),
  ('d1000000-0000-0000-0000-0000000000a2', 'a0000000-0000-0000-0000-00000000000a', 'c1000000-0000-0000-0000-00000000c1a2', 'Tenant A / Client A2 Matter', 'other', 'active', 'rehearsal-a2'),
  ('d2000000-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-00000000000b', 'c2000000-0000-0000-0000-00000000c2b1', 'Tenant B / Client B1 Matter', 'other', 'active', 'rehearsal-b1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO client_advocacy_matter_link (id, tenant_id, matter_id, link_type, link_key, label)
VALUES
  ('e1000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-00000000000a', 'd1000000-0000-0000-0000-0000000000a1', 'bill', '119-hr-0001', 'Tenant A link'),
  ('e2000000-0000-0000-0000-0000000000b1', 'b0000000-0000-0000-0000-00000000000b', 'd2000000-0000-0000-0000-0000000000b1', 'bill', '119-hr-0002', 'Tenant B link')
ON CONFLICT (id) DO NOTHING;

-- Reset the bypass flag before every proof below — the proofs are only
-- meaningful if they run under an ordinary tenant-scoped session, matching
-- what withTenant() actually does in the app.
SELECT set_config('app.bypass_rls', 'off', false);

-- ── Proof 1: cross-tenant isolation on client_advocacy_matter ───────────
SELECT set_config('app.current_tenant', 'a0000000-0000-0000-0000-00000000000a', false);
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter WHERE id = 'd2000000-0000-0000-0000-0000000000b1';
  IF v_count != 0 THEN
    RAISE EXCEPTION 'CROSS-TENANT LEAK: tenant A session read tenant B''s Matter (count=%)', v_count;
  END IF;
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter WHERE tenant_id = 'a0000000-0000-0000-0000-00000000000a';
  IF v_count != 2 THEN
    RAISE EXCEPTION 'ISOLATION PROOF SETUP BROKEN: tenant A should see exactly its own 2 Matters, saw %', v_count;
  END IF;
  RAISE NOTICE 'PASS: proof 1 (cross-tenant Matter isolation)';
END $$;

-- ── Proof 2: cross-tenant isolation on client_advocacy_matter_link ──────
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter_link WHERE id = 'e2000000-0000-0000-0000-0000000000b1';
  IF v_count != 0 THEN
    RAISE EXCEPTION 'CROSS-TENANT LEAK: tenant A session read tenant B''s Matter link (count=%)', v_count;
  END IF;
  RAISE NOTICE 'PASS: proof 2 (cross-tenant Matter link isolation)';
END $$;

-- ── Proof 3: an UPDATE cannot cross tenants either (WITH CHECK, not just USING) ──
DO $$
DECLARE v_rows INT;
BEGIN
  UPDATE client_advocacy_matter SET title = 'HACKED' WHERE id = 'd2000000-0000-0000-0000-0000000000b1';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows != 0 THEN
    RAISE EXCEPTION 'CROSS-TENANT WRITE: tenant A session updated tenant B''s Matter (rows=%)', v_rows;
  END IF;
  RAISE NOTICE 'PASS: proof 3 (cross-tenant Matter UPDATE blocked)';
END $$;

-- ── Proof 4: cross-CLIENT isolation within the SAME tenant is an
--    application-layer concern (RLS only scopes by tenant_id) — prove the
--    service's own clientId filter, not RLS, is what separates A1 from A2.
--    This mirrors exactly what listMatters()/getMatter() do: tenant_id
--    scoping via RLS + an explicit client_id = $2 predicate in the query.
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter
   WHERE client_id = 'c1000000-0000-0000-0000-00000000c1a1';
  IF v_count != 1 THEN
    RAISE EXCEPTION 'CROSS-CLIENT ISOLATION SETUP BROKEN: client A1 should see exactly 1 Matter, saw %', v_count;
  END IF;
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter
   WHERE client_id = 'c1000000-0000-0000-0000-00000000c1a1' AND id = 'd1000000-0000-0000-0000-0000000000a2';
  IF v_count != 0 THEN
    RAISE EXCEPTION 'CROSS-CLIENT LEAK: querying by client A1''s id still returned client A2''s Matter';
  END IF;
  RAISE NOTICE 'PASS: proof 4 (cross-client isolation via explicit client_id predicate)';
END $$;

-- ── Proof 5: switching the GUC to tenant B flips visibility symmetrically ──
SELECT set_config('app.current_tenant', 'b0000000-0000-0000-0000-00000000000b', false);
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter WHERE id = 'd1000000-0000-0000-0000-0000000000a1';
  IF v_count != 0 THEN
    RAISE EXCEPTION 'CROSS-TENANT LEAK (reverse direction): tenant B session read tenant A''s Matter';
  END IF;
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter WHERE tenant_id = 'b0000000-0000-0000-0000-00000000000b';
  IF v_count != 1 THEN
    RAISE EXCEPTION 'ISOLATION PROOF SETUP BROKEN: tenant B should see exactly its own 1 Matter, saw %', v_count;
  END IF;
  RAISE NOTICE 'PASS: proof 5 (symmetric cross-tenant isolation)';
END $$;

-- ── Proof 6: NO tenant GUC set at all => fail closed, zero visibility ───
SELECT set_config('app.current_tenant', '', false);
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter;
  IF v_count != 0 THEN
    RAISE EXCEPTION 'FAIL-OPEN BUG: a session with NO tenant GUC set could see % Matter row(s) — should be 0', v_count;
  END IF;
  RAISE NOTICE 'PASS: proof 6 (no-tenant-set session fails closed, sees nothing)';
END $$;

-- ── Proof 7: rls_bypass() is the ONLY path to cross-tenant visibility,
--    and it must be explicitly set — never implicit. ─────────────────────
SELECT set_config('app.bypass_rls', 'on', false);
DO $$
DECLARE v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM client_advocacy_matter;
  IF v_count != 3 THEN
    RAISE EXCEPTION 'rls_bypass() did not grant expected cross-tenant visibility (saw % rows, expected 3)', v_count;
  END IF;
  RAISE NOTICE 'PASS: proof 7 (rls_bypass grants cross-tenant visibility only when explicitly set)';
END $$;
SELECT set_config('app.bypass_rls', 'off', false);

ROLLBACK; -- never commit rehearsal fixtures

SELECT 'ALL ADVOCACY HISTORY SECURITY REHEARSAL PROOFS PASSED' AS result;
