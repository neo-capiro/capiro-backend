ALTER TABLE intel_sms_verification
  ADD COLUMN purpose text NOT NULL DEFAULT 'legacy_unbound' CHECK(purpose IN ('legacy_unbound','tracker_alerts','hearing_updates')),
  ADD COLUMN provider_accepted boolean NOT NULL DEFAULT false,
  ADD COLUMN confirmed_at timestamptz,
  ADD COLUMN consent_version text;
CREATE INDEX intel_sms_verification_scope_idx ON intel_sms_verification(tenant_id,user_id,client_id,phone,purpose,created_at);
CREATE TABLE intel_hearing_sms_consent (
  id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, client_id text NOT NULL, phone text NOT NULL,
  purpose text NOT NULL DEFAULT 'hearing_updates' CHECK(purpose='hearing_updates'),
  verification_id text NOT NULL UNIQUE REFERENCES intel_sms_verification(id), consent_version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
  UNIQUE(tenant_id,user_id,client_id,phone,purpose), CHECK(phone ~ '^\+[1-9][0-9]{9,14}$')
);
ALTER TABLE intel_hearing_sms_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_sms_consent FORCE ROW LEVEL SECURITY;
CREATE POLICY hearing_sms_consent_scope ON intel_hearing_sms_consent
  USING(current_setting('app.bypass_rls',true)='on' OR tenant_id=current_setting('app.current_tenant',true))
  WITH CHECK(current_setting('app.bypass_rls',true)='on' OR tenant_id=current_setting('app.current_tenant',true));
GRANT SELECT,INSERT,UPDATE ON intel_hearing_sms_consent TO capiro_app;
