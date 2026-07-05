-- Row-Level Security for clio_memory (Meri's learned-facts store).
--
-- clio_memory was the last tenant-scoped Meri table without RLS: isolation was
-- enforced only by every query remembering `WHERE tenant_id = ...`. This brings
-- it in line with every other isolated table (memory_items, tenants, etc.):
-- fail-closed at the DB layer. Follows the pattern from migration
-- 20260501000000 (rls_bypass() OR tenant_id = current_tenant_id()).
--
-- PRECONDITION (verified before merge): every clio_memory reader/writer runs
-- inside PrismaService.withTenant (sets app.current_tenant) or withSystem (sets
-- app.bypass_rls). The two standalone scripts (backfill-clio-memory-embeddings,
-- diag-clio-memory) set app.bypass_rls in a transaction. A caller that forgets
-- will now correctly return 0 rows instead of silently crossing tenants.
--
-- FUTURE MIGRATIONS: any data write to clio_memory AFTER this point must set
-- `SET LOCAL app.bypass_rls = 'on'` (or run pre-RLS) or it will match 0 rows.

ALTER TABLE "clio_memory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "clio_memory" FORCE ROW LEVEL SECURITY;

CREATE POLICY "clio_memory_isolation" ON "clio_memory"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "clio_memory" TO capiro_app;
  END IF;
END
$$;
