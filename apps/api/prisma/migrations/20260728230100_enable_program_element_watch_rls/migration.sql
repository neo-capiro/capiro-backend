-- Phase C security correction: ProgramElementWatch is tenant-owned, but its
-- original migration created tenant_id without enabling row-level security.
-- Establish the repository's standard fail-closed tenant policy separately from
-- the index-only expand migration so each migration has one explicit concern.
--
-- Abort if an out-of-band policy already exists. Multiple PostgreSQL policies
-- are OR-combined, so silently adding another policy could widen access.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'program_element_watch'
  ) THEN
    RAISE EXCEPTION
      'program_element_watch already has an RLS policy; review it before applying the canonical isolation policy';
  END IF;
END
$$;

ALTER TABLE "program_element_watch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "program_element_watch" FORCE ROW LEVEL SECURITY;

CREATE POLICY "program_element_watch_isolation" ON "program_element_watch"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
