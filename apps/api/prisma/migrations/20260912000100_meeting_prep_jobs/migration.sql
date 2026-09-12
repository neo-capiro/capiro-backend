CREATE TABLE meeting_prep_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  request_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage varchar(48) NOT NULL DEFAULT 'queued',
  depth varchar(16) NOT NULL DEFAULT 'standard' CHECK (depth IN ('standard','deep')),
  input jsonb NOT NULL,
  checkpoints jsonb NOT NULL DEFAULT '{}',
  lease_token uuid,
  lease_until timestamptz,
  deadline_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  prep_id uuid REFERENCES meeting_preps(id) ON DELETE SET NULL,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE meeting_prep_monday_mappings (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  board_ids text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meeting_prep_monday_mappings_tenant_id_user_id_client_id_key ON meeting_prep_monday_mappings(tenant_id,user_id,client_id);
ALTER TABLE meeting_prep_monday_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_prep_monday_mappings FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_prep_monday_mappings_scope ON meeting_prep_monday_mappings USING (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
) WITH CHECK (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
);
CREATE UNIQUE INDEX meeting_prep_jobs_tenant_id_user_id_request_key_key ON meeting_prep_jobs(tenant_id,user_id,request_key);
CREATE INDEX meeting_prep_jobs_status_lease_until_created_at_idx ON meeting_prep_jobs(status,lease_until,created_at);
CREATE INDEX meeting_prep_jobs_tenant_id_user_id_meeting_id_created_at_idx ON meeting_prep_jobs(tenant_id,user_id,meeting_id,created_at);
ALTER TABLE meeting_prep_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_prep_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_prep_jobs_scope ON meeting_prep_jobs USING (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
   AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
) WITH CHECK (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
   AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
);
