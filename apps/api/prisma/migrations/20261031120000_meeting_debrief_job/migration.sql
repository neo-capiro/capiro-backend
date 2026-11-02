-- D2 (2026-10): record the assembled debrief context with the artifact it produced.
-- Nullable: every existing debrief row predates the bounded-context change.
ALTER TABLE meeting_debriefs ADD COLUMN generated_from_jsonb jsonb;

-- D1 (2026-10): async debrief job, mirroring meeting_prep_jobs. No new queue/broker.
CREATE TABLE meeting_debrief_jobs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE ON UPDATE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  meeting_id uuid NOT NULL REFERENCES meetings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  request_key varchar(128) NOT NULL,
  request_hash varchar(64) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed','cancelled')),
  stage varchar(48) NOT NULL DEFAULT 'queued',
  input jsonb NOT NULL,
  checkpoints jsonb NOT NULL DEFAULT '{}',
  lease_token uuid,
  lease_until timestamptz,
  deadline_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  debrief_id uuid REFERENCES meeting_debriefs(id) ON DELETE SET NULL ON UPDATE CASCADE,
  error_code varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX meeting_debrief_jobs_tenant_id_user_id_request_key_key ON meeting_debrief_jobs(tenant_id,user_id,request_key);
CREATE INDEX meeting_debrief_jobs_status_lease_until_created_at_idx ON meeting_debrief_jobs(status,lease_until,created_at);
CREATE INDEX meeting_debrief_jobs_tenant_id_user_id_meeting_id_created_at_idx ON meeting_debrief_jobs(tenant_id,user_id,meeting_id,created_at);
ALTER TABLE meeting_debrief_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_debrief_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_debrief_jobs_scope ON meeting_debrief_jobs USING (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
   AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
) WITH CHECK (
  current_setting('app.bypass_rls', true) = 'on' OR
  (tenant_id = nullif(current_setting('app.current_tenant', true), '')::uuid
   AND user_id = nullif(current_setting('app.current_user', true), '')::uuid)
);
