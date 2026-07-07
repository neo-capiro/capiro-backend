-- PE Watch plan Phase 2: per-user email-alert preference for PE Watch alerts,
-- configured from the /program-elements surface. Tenant-scoped with RLS per
-- the house pattern (rls_bypass() OR tenant_id = current_tenant_id()).
-- Absence of a row = 'daily' for users with >=1 program_element_watch.

CREATE TABLE "pe_alert_email_pref" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mode" VARCHAR(24) NOT NULL DEFAULT 'daily',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pe_alert_email_pref_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pe_alert_email_pref_user_tenant_key" ON "pe_alert_email_pref"("user_id", "tenant_id");
CREATE INDEX "pe_alert_email_pref_tenant_idx" ON "pe_alert_email_pref"("tenant_id");

ALTER TABLE "pe_alert_email_pref"
    ADD CONSTRAINT "pe_alert_email_pref_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "pe_alert_email_pref"
    ADD CONSTRAINT "pe_alert_email_pref_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: tenant isolation, fail-closed without the GUC; rls_bypass() covers
-- system/worker paths (withSystem) exactly like the other tenant tables.
ALTER TABLE "pe_alert_email_pref" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pe_alert_email_pref" FORCE ROW LEVEL SECURITY;
CREATE POLICY "pe_alert_email_pref_tenant_isolation" ON "pe_alert_email_pref"
    USING (rls_bypass() OR tenant_id = current_tenant_id())
    WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON "pe_alert_email_pref" TO capiro_app;
