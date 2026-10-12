ALTER TABLE "outreach_draft_versions"
  ADD COLUMN "content_format" VARCHAR(32) NOT NULL DEFAULT 'outreach',
  ADD COLUMN "newsletter_stage_id" UUID;

ALTER TABLE "outreach_draft_versions" ADD CONSTRAINT "outreach_newsletter_source_required"
  CHECK (content_format = 'outreach' OR
    (content_format = 'workspace_newsletter' AND newsletter_stage_id IS NOT NULL
      AND generation_status = 'manually_authored'));

CREATE TABLE "newsletter_recipient_access" (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL, user_id UUID NOT NULL,
  stage_id UUID NOT NULL, outreach_record_id UUID NOT NULL,
  draft_version_id UUID, token VARCHAR(64) NOT NULL UNIQUE,
  email VARCHAR(320) NOT NULL, html TEXT NOT NULL,
  survey_answers JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "newsletter_recipient_access_tenant_id_user_id_outreach_record_id_idx"
  ON newsletter_recipient_access(tenant_id, user_id, outreach_record_id);
CREATE TABLE "newsletter_subscriptions" (
  id UUID PRIMARY KEY, tenant_id UUID NOT NULL, user_id UUID NOT NULL,
  email VARCHAR(320) NOT NULL, unsubscribed_at TIMESTAMPTZ,
  UNIQUE(tenant_id, user_id, email)
);

ALTER TABLE newsletter_recipient_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_recipient_access FORCE ROW LEVEL SECURITY;
CREATE POLICY newsletter_recipient_access_isolation ON newsletter_recipient_access
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE newsletter_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY newsletter_subscriptions_isolation ON newsletter_subscriptions
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_recipient_access, newsletter_subscriptions TO capiro_app;
  END IF;
END $$;
