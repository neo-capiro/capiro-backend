-- Durable import progress; provider reads and local item commits are not one atomic operation.
CREATE TABLE calendar_sync_commands (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('microsoft_365','google_workspace')),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 1024),
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command_jsonb JSONB NOT NULL,
  window_jsonb JSONB NOT NULL,
  progress_jsonb JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id,actor_user_id,request_id),
  CHECK ((jsonb_typeof(command_jsonb)='object' AND command_jsonb->>'schemaVersion'='1'
    AND command_jsonb->>'requestId'=request_id::text AND jsonb_typeof(window_jsonb)='object'
    AND jsonb_typeof(window_jsonb->'from')='string' AND jsonb_typeof(window_jsonb->'to')='string'
    AND jsonb_typeof(progress_jsonb)='object' AND jsonb_typeof(progress_jsonb->'lastStats')='object'
    AND jsonb_typeof(progress_jsonb->'lastStats'->'hasMore')='boolean') IS TRUE),
  CHECK (status <> 'completed' OR (progress_jsonb->'lastStats'->>'hasMore'='false') IS TRUE)
);
CREATE INDEX calendar_sync_commands_connection_idx ON calendar_sync_commands(tenant_id,connection_id,status);
CREATE UNIQUE INDEX calendar_sync_commands_one_pending ON calendar_sync_commands(tenant_id,connection_id) WHERE status='pending';
CREATE FUNCTION calendar_sync_command_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR
    (to_jsonb(NEW)-ARRAY['progress_jsonb','status','updated_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['progress_jsonb','status','updated_at']) THEN
    RAISE EXCEPTION 'Calendar request identity and completed progress are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER calendar_sync_command_transition BEFORE UPDATE ON calendar_sync_commands
  FOR EACH ROW EXECUTE FUNCTION calendar_sync_command_transition();
ALTER TABLE calendar_sync_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE calendar_sync_commands FORCE ROW LEVEL SECURITY;
CREATE POLICY calendar_sync_commands_isolation ON calendar_sync_commands
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON calendar_sync_commands TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON calendar_sync_commands FROM capiro_app;
    GRANT UPDATE(progress_jsonb,status,updated_at) ON calendar_sync_commands TO capiro_app;
  END IF;
END $$;
