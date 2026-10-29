-- PROPOSAL ONLY: separate forward tenant-policy prerequisite for explicit root review.
-- Existing source migrations never enabled RLS on these three tenant tables.
-- Fail closed on an unexpected baseline. No existing policy is replaced or dropped.
-- Existing app/system readers still require their canonical tenant/bypass context.
DO $baseline$ BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('client_people','engagement_campaigns','engagement_campaign_recipients')
      AND c.relkind='r' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)) <> 3 THEN
    RAISE EXCEPTION 'Unexpected saved business tenant-policy baseline';
  END IF;
END $baseline$;

ALTER TABLE public.client_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_people FORCE ROW LEVEL SECURITY;
CREATE POLICY client_people_isolation ON public.client_people
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());

ALTER TABLE public.engagement_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_campaigns_isolation ON public.engagement_campaigns
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());

ALTER TABLE public.engagement_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.engagement_campaign_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY engagement_campaign_recipients_isolation ON public.engagement_campaign_recipients
  USING (public.rls_bypass() OR tenant_id = public.current_tenant_id())
  WITH CHECK (public.rls_bypass() OR tenant_id = public.current_tenant_id());
