-- ============================================================================
-- RLS ROLE HARDENING — make Postgres RLS actually bind the runtime app role
-- ============================================================================
-- Context: docs/plans/2026-07-19-capiro-app-rls-bypass-remediation.md
--
-- ROOT CAUSE (dev-proven 2026-07-19, Aurora PostgreSQL 16.11 / aurora_version
-- 16.11.2): Aurora exempts any role that holds the privileges of
-- `rds_superuser` from row-level security even when the role has
-- rolbypassrls=f and the table has ENABLE + FORCE ROW LEVEL SECURITY.
-- `capiro_app` inherited rds_superuser transitively:
--     capiro_app -> capiro_master -> rds_superuser
-- Proof: a throwaway role granted ONLY rds_superuser read every tenant's rows
-- with no policy filter in the plan; a plain role with identical direct table
-- grants was correctly filtered to zero rows (policies + FORCE work fine).
--
-- This script is an OPS runbook, executed out-of-band as capiro_master via the
-- dbadmin one-off ECS task (NOT a Prisma migration: prisma migrate runs fine
-- before and after, but a role-membership change is cluster-level ops and must
-- not be replayed by `migrate deploy` on scratch DBs, where capiro_app is
-- created without the capiro_master membership in the first place).
--
-- Safe-to-run preconditions (verified in dev before first execution):
--   * Every public relation already carries direct grants to capiro_app
--     (pg_default_acl from capiro_master covers tables + sequences), so
--     revoking the membership removes NO privilege any code path uses.
--   * All services (api, intel-api, onboard-api, meriv2-orchestrator,
--     workspace) connect as capiro_app and route tenant work through
--     withTenant/withTenantUser (sets app.current_tenant SET LOCAL) or
--     withSystem (sets app.bypass_rls SET LOCAL), which is exactly the
--     contract the policies (`rls_bypass() OR tenant predicate`) expect.
--   * Prisma migrations run as capiro_master (api-admin-migrate task def).
--
-- Idempotent: yes (re-running is a no-op).
-- Rollback: GRANT capiro_master TO capiro_app; (restores the old bypass —
--           only as an emergency hatch, this reopens the security hole).
-- ============================================================================

-- 1. The runtime role must not OWN tables: an owner can ALTER TABLE ... DISABLE
--    ROW LEVEL SECURITY, so app-role ownership leaves RLS one compromised
--    connection away from being switched off. Normalize the legacy
--    capiro_app-owned tables (intel_*, memory_items, memory_edges,
--    document_parse_job) to capiro_master like every other table.
--    NOTE: ALTER ... OWNER rewrites the old owner's ACL entries to the new
--    owner, so step 2 must re-grant CRUD to capiro_app afterwards.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND pg_get_userbyid(c.relowner) = 'capiro_app'
  LOOP
    EXECUTE format('ALTER TABLE public.%I OWNER TO capiro_master', t.relname);
  END LOOP;
END $$;

-- 2. Explicit privileges for the runtime role (matches the arwdDxt set the
--    default ACL already grants on capiro_master-created tables; keeps the
--    transferred tables working identically).
GRANT ALL ON ALL TABLES IN SCHEMA public TO capiro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO capiro_app;

-- 3. THE fix: break capiro_app -> capiro_master -> rds_superuser, which is the
--    chain Aurora's RLS exemption keys on. After this, ENABLE+FORCE RLS and the
--    existing policies bind every service connection.
REVOKE capiro_master FROM capiro_app;

-- 4. Let admin tooling keep impersonating the app role for behavioral probes
--    (SET ROLE capiro_app requires membership). Strictly one-directional:
--    capiro_master gains capiro_app's (lesser) privileges; capiro_app gains
--    nothing. Must run AFTER step 3 or Postgres rejects it as circular.
GRANT capiro_app TO capiro_master;

-- ============================================================================
-- ACCEPTANCE (run as capiro_master in the same or a fresh session):
--   SET ROLE capiro_app;
--   SELECT count(*) FROM clio_memory;    -- expect 0 (no GUCs)
--   SELECT count(*) FROM memory_items;   -- expect 0 (no GUCs)
--   EXPLAIN SELECT count(*) FROM clio_memory;  -- expect policy Filter present
--   -- tenant scope works:
--   BEGIN; SELECT set_config('app.current_tenant', '<tenant uuid>', true);
--   SELECT count(*) FROM clio_memory; COMMIT;  -- expect that tenant's count
--   -- system bypass works (withSystem parity):
--   BEGIN; SELECT set_config('app.bypass_rls', 'on', true);
--   SELECT count(*) FROM clio_memory; COMMIT;  -- expect full count
--   RESET ROLE;
-- ============================================================================
