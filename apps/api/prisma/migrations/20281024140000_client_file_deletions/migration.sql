-- Retain the reviewed file and physical object before deletion can erase them.
-- Resource deletion must not erase or rewrite this recovery record.
CREATE TABLE IF NOT EXISTS client_file_deletions (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  client_id UUID NOT NULL,
  attachment_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command_jsonb JSONB NOT NULL,
  source_jsonb JSONB NOT NULL,
  object_jsonb JSONB NOT NULL,
  claimed_revision INTEGER NOT NULL CHECK (claimed_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','completed')),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ(6),
  PRIMARY KEY (tenant_id,actor_user_id,request_id),
  UNIQUE (tenant_id,attachment_id),
  -- The metadata trigger increments once when lifecycle_status changes to
  -- delete_pending; the largest reviewable revision is therefore INT_MAX-1.
  CHECK ((command_jsonb=jsonb_build_object(
    'schemaVersion',1,'requestId',request_id::text,'clientId',client_id::text,
    'expectedRevision',claimed_revision-1,'attachmentId',attachment_id::text
  )) IS TRUE),
  CHECK ((
    jsonb_typeof(source_jsonb)='object'
    AND source_jsonb ?& ARRAY['id','clientId','prospectId','meetingId','mailMessageId',
      'bucket','s3Key','metadataRevision','lifecycleStatus','sourceEntityType']
    AND source_jsonb-ARRAY['id','clientId','prospectId','meetingId','mailMessageId',
      'bucket','s3Key','metadataRevision','lifecycleStatus','sourceEntityType']='{}'::jsonb
    AND source_jsonb->'id'=to_jsonb(attachment_id::text)
    AND source_jsonb->'clientId'=to_jsonb(client_id::text)
    AND source_jsonb->'prospectId'='null'::jsonb
    AND (source_jsonb->'meetingId'='null'::jsonb OR (
      jsonb_typeof(source_jsonb->'meetingId')='string'
      AND source_jsonb->>'meetingId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    AND (source_jsonb->'mailMessageId'='null'::jsonb OR (
      jsonb_typeof(source_jsonb->'mailMessageId')='string'
      AND source_jsonb->>'mailMessageId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'))
    AND jsonb_typeof(source_jsonb->'bucket')='string'
    AND length(source_jsonb->>'bucket') BETWEEN 1 AND 255
    AND jsonb_typeof(source_jsonb->'s3Key')='string'
    AND octet_length(source_jsonb->>'s3Key') BETWEEN 1 AND 1024
    AND source_jsonb->'metadataRevision'=to_jsonb(claimed_revision-1)
    AND jsonb_typeof(source_jsonb->'lifecycleStatus')='string'
    AND length(source_jsonb->>'lifecycleStatus') BETWEEN 1 AND 32
    AND source_jsonb->>'lifecycleStatus' NOT IN ('delete_pending','delete_failed')
    AND (source_jsonb->'sourceEntityType'='null'::jsonb OR (
      jsonb_typeof(source_jsonb->'sourceEntityType')='string'
      AND length(source_jsonb->>'sourceEntityType') <= 64
      AND source_jsonb->>'sourceEntityType'<>'meri_synthetic_fixture'))
  ) IS TRUE),
  CHECK ((
    jsonb_typeof(object_jsonb)='object'
    AND object_jsonb ?& ARRAY['bucket','key','etag']
    AND object_jsonb-ARRAY['bucket','key','etag']='{}'::jsonb
    AND object_jsonb->'bucket'=source_jsonb->'bucket'
    AND object_jsonb->'key'=source_jsonb->'s3Key'
    AND (object_jsonb->'etag'='null'::jsonb OR (
      jsonb_typeof(object_jsonb->'etag')='string'
      AND object_jsonb->>'etag' !~ '^[[:space:]]*([*][[:space:]]*)?$'))
  ) IS TRUE),
  CHECK ((status='pending' AND completed_at IS NULL)
    OR (status='completed' AND completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS client_file_deletions_object_key
  ON client_file_deletions ((object_jsonb->>'bucket'),(object_jsonb->>'key'));
CREATE OR REPLACE FUNCTION client_file_deletion_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'File deletion must begin pending' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.status <> 'pending' OR NEW.status <> 'completed'
    OR (to_jsonb(NEW)-ARRAY['status','completed_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','completed_at']) THEN
    RAISE EXCEPTION 'File deletion identity and completed result are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS client_file_deletion_transition ON client_file_deletions;
CREATE TRIGGER client_file_deletion_transition BEFORE INSERT OR UPDATE ON client_file_deletions
  FOR EACH ROW EXECUTE FUNCTION client_file_deletion_transition();
ALTER TABLE client_file_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_file_deletions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_file_deletion_isolation ON client_file_deletions;
CREATE POLICY client_file_deletion_isolation ON client_file_deletions
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON client_file_deletions TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON client_file_deletions FROM capiro_app;
    GRANT UPDATE(status,completed_at) ON client_file_deletions TO capiro_app;
  END IF;
END $$;
