CREATE TABLE intel_hearing_record_job (
  id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,owner_clerk_id TEXT NOT NULL,event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('reconcile','brief')),input_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed','obsolete')),
  payload JSONB NOT NULL,result_id TEXT,lease_token TEXT,lease_until TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,owner_clerk_id,kind,input_hash)
);
ALTER TABLE intel_hearing_record_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE intel_hearing_record_job FORCE ROW LEVEL SECURITY;
CREATE POLICY record_job_owner ON intel_hearing_record_job USING
 (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true))
 WITH CHECK (tenant_id=current_tenant_id()::text AND owner_clerk_id=current_setting('app.folder_actor',true));
GRANT SELECT,INSERT,UPDATE ON intel_hearing_record_job TO capiro_app;
REVOKE DELETE,TRUNCATE ON intel_hearing_record_job FROM capiro_app;
CREATE INDEX record_job_due ON intel_hearing_record_job(next_attempt_at) WHERE state IN ('pending','failed','running');
