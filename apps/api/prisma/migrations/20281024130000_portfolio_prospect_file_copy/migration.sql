-- Each external write has a recorded, immutable source and destination before
-- storage work begins. Only final attachment admission completes the copy.
CREATE TABLE IF NOT EXISTS prospect_attachment_copies (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  prospect_id UUID NOT NULL,
  client_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command_jsonb JSONB NOT NULL,
  source_jsonb JSONB NOT NULL,
  destination_id UUID NOT NULL,
  bucket TEXT NOT NULL CHECK (length(bucket) BETWEEN 1 AND 255),
  object_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  result_jsonb JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6),
  PRIMARY KEY (tenant_id,actor_user_id,request_id),
  UNIQUE (destination_id),
  UNIQUE (bucket,object_key),
  CHECK (object_key='tenants/' || tenant_id::text || '/engagement/prospect-client-copies/' || destination_id::text || '/document'),
  CHECK ((
    jsonb_typeof(command_jsonb)='object'
    AND command_jsonb->>'schemaVersion'='1'
    AND command_jsonb->>'requestId'=request_id::text
    AND command_jsonb->>'prospectId'=prospect_id::text
    AND command_jsonb->>'clientId'=client_id::text
    AND command_jsonb->>'checksumSha256' ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(source_jsonb)='object'
    AND source_jsonb->>'bucket'=bucket
    AND source_jsonb->>'checksumSha256'=command_jsonb->>'checksumSha256'
    AND source_jsonb->>'contentLength'=command_jsonb->>'contentLength'
    AND length(source_jsonb->>'key') BETWEEN 1 AND 1024
    AND length(source_jsonb->>'fileName') BETWEEN 1 AND 1024
    AND length(source_jsonb->>'contentType') BETWEEN 1 AND 255
  ) IS TRUE),
  CHECK ((
    (status='pending' AND result_jsonb IS NULL AND completed_at IS NULL)
    OR (status='completed' AND completed_at IS NOT NULL AND result_jsonb IS NOT NULL
      AND jsonb_typeof(result_jsonb)='object' AND result_jsonb->>'id'=destination_id::text)
  ) IS TRUE)
);
CREATE OR REPLACE FUNCTION prospect_attachment_copy_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' OR NEW.status <> 'completed'
    OR (to_jsonb(NEW)-ARRAY['status','result_jsonb','completed_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','result_jsonb','completed_at']) THEN
    RAISE EXCEPTION 'File copy identity and completed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prospect_attachment_copy_transition ON prospect_attachment_copies;
CREATE TRIGGER prospect_attachment_copy_transition BEFORE UPDATE ON prospect_attachment_copies
  FOR EACH ROW EXECUTE FUNCTION prospect_attachment_copy_transition();
ALTER TABLE prospect_attachment_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_attachment_copies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospect_attachment_copy_isolation ON prospect_attachment_copies;
CREATE POLICY prospect_attachment_copy_isolation ON prospect_attachment_copies
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON prospect_attachment_copies TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON prospect_attachment_copies FROM capiro_app;
    GRANT UPDATE(status,result_jsonb,completed_at) ON prospect_attachment_copies TO capiro_app;
  END IF;
END $$;
