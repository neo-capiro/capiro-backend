-- Phase C expand migration: add the tenant-aware natural key while the
-- legacy (user_id, pe_code) key remains in place for rollback safety.
--
-- The legacy key is intentionally NOT dropped here. Dropping it is a separate
-- contract release after all API and sync-job task definitions use the new code.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "program_element_watch"
    GROUP BY "tenant_id", "user_id", "pe_code"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'program_element_watch contains duplicate tenant/user/PE rows; aborting tenant-key expansion';
  END IF;
END
$$;

CREATE UNIQUE INDEX "program_element_watch_tenant_user_pe_code_key"
  ON "program_element_watch"("tenant_id", "user_id", "pe_code");

-- The original ProgramElementWatch migration created a tenant_id column but did
-- not enable RLS or install a tenant policy. Phase C establishes the repository's
-- standard fail-closed tenant boundary while introducing the tenant-aware key.
ALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY;

CREATE POLICY "program_element_watch_isolation" ON "program_element_watch"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
