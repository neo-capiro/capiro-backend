-- outreach_ai_template is tenant-owned (tenant_id NOT NULL, FK to tenants), but
-- 20260521011251_outreach_ai_templates created it without row-level security.
-- Every other tenant table in the engagement/outreach domain (outreach_records,
-- outreach_templates, outreach_draft_*, outreach_send_intents, outreach_deliveries,
-- outreach_jobs, outreach_audiences, engagement_campaigns, meetings, ...) carries
-- the repository's standard fail-closed isolation policy. Establish it here so the
-- database backstop matches the in-query tenant predicate the application already
-- applies through PrismaService.withTenant().
--
-- Abort if an out-of-band policy already exists. Multiple PostgreSQL policies
-- are OR-combined, so silently adding another policy could widen access.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = current_schema()
      AND tablename = 'outreach_ai_template'
  ) THEN
    RAISE EXCEPTION
      'outreach_ai_template already has an RLS policy; review it before applying the canonical isolation policy';
  END IF;
END
$$;

ALTER TABLE "outreach_ai_template" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_ai_template" FORCE ROW LEVEL SECURITY;

CREATE POLICY "outreach_ai_template_isolation" ON "outreach_ai_template"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
