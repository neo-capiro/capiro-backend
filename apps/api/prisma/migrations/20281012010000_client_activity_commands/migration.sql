-- SOURCE PREPARATION ONLY: no migration execution authorized in this work.
-- Allocation: docs/core-quick-log-20261012/SCOPE.md. No backfill.
CREATE TABLE client_activity_commands (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  actor_clerk_user_id varchar(255) NOT NULL,
  request_id uuid NOT NULL,
  request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  -- Historical IDs intentionally do not block legacy deletion or erase receipts.
  activity_id uuid NOT NULL,
  person_id uuid NULL,
  assignee_user_id uuid NULL,
  assignee_clerk_user_id varchar(255) NULL,
  planner_payload jsonb NULL,
  status varchar(16) NOT NULL CHECK (status IN ('pending', 'completed')),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  task_id uuid NULL,
  attempt_token uuid NULL,
  lease_until timestamptz NULL,
  error_code varchar(64) NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_activity_commands_client_fk FOREIGN KEY (tenant_id, client_id)
    REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT client_activity_commands_request_key UNIQUE (tenant_id, actor_user_id, client_id, request_id),
  CONSTRAINT client_activity_commands_follow_up_chk CHECK (
    (assignee_user_id IS NULL AND assignee_clerk_user_id IS NULL AND planner_payload IS NULL
      AND task_id IS NULL AND status = 'completed') OR
    (assignee_user_id IS NOT NULL AND assignee_clerk_user_id IS NOT NULL
      AND planner_payload IS NOT NULL AND jsonb_typeof(planner_payload) = 'object'
      AND ((status = 'completed' AND task_id IS NOT NULL) OR (status = 'pending' AND task_id IS NULL)))
  ),
  CONSTRAINT client_activity_commands_attempt_chk CHECK (
    (attempt_token IS NULL AND lease_until IS NULL) OR
    (attempt_token IS NOT NULL AND lease_until IS NOT NULL AND status = 'pending')
  )
);

ALTER TABLE client_activity_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_activity_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY client_activity_commands_tenant_isolation ON client_activity_commands
  USING (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- No public delete API. Access checks additionally bind every lookup to actor
-- and client; RLS is tenant isolation, not a substitute for those checks.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON client_activity_commands TO capiro_app;
  END IF;
END $$;
