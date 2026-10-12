-- SOURCE ONLY. Not executed/qualified against a native database.
-- Core owns prospect identity, engagement attachments and upload intents.
ALTER TABLE engagement_attachments ADD COLUMN prospect_id uuid;
ALTER TABLE engagement_attachments ADD CONSTRAINT engagement_attachments_prospect_fkey
 FOREIGN KEY (tenant_id,prospect_id) REFERENCES business_development_prospects(tenant_id,id) ON DELETE RESTRICT;
ALTER TABLE engagement_attachments ADD CONSTRAINT engagement_attachments_prospect_parent_check
 CHECK (prospect_id IS NULL OR (client_id IS NULL AND meeting_id IS NULL AND mail_message_id IS NULL));
CREATE INDEX engagement_attachments_prospect_idx ON engagement_attachments(tenant_id,prospect_id,created_at);

CREATE TABLE prospect_attachment_upload_intents (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
 tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
 prospect_id uuid NOT NULL,
 actor_user_id uuid NOT NULL,
 request_id uuid NOT NULL,
 file_name text NOT NULL,
 content_type text NOT NULL,
 content_length integer NOT NULL CHECK (content_length BETWEEN 1 AND 26214400),
 checksum_sha256 varchar(64) NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
 bucket text NOT NULL,
 s3_key text NOT NULL,
 expires_at timestamptz NOT NULL,
 confirmed_attachment_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT prospect_attachment_upload_intents_prospect_fkey FOREIGN KEY (tenant_id,prospect_id)
 REFERENCES business_development_prospects(tenant_id,id) ON DELETE RESTRICT,
 CONSTRAINT prospect_attachment_upload_intents_request_key UNIQUE (tenant_id,actor_user_id,request_id),
 CONSTRAINT prospect_attachment_upload_intents_s3_key UNIQUE (tenant_id,s3_key)
);
CREATE INDEX prospect_attachment_upload_intents_prospect_idx ON prospect_attachment_upload_intents(tenant_id,prospect_id);
ALTER TABLE prospect_attachment_upload_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_attachment_upload_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY prospect_attachment_upload_intents_isolation ON prospect_attachment_upload_intents
 USING (tenant_id = NULLIF(current_setting('app.current_tenant',true),'')::uuid OR current_setting('app.bypass_rls',true)='on')
 WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant',true),'')::uuid OR current_setting('app.bypass_rls',true)='on');

-- Preserve User ON DELETE SET NULL erasure; the intent retains original actor UUID.
-- A non-null uploader can never be reassigned (including after erasure).
CREATE FUNCTION preserve_prospect_attachment_origin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.prospect_id IS DISTINCT FROM OLD.prospect_id OR
   (OLD.prospect_id IS NOT NULL AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.s3_key IS DISTINCT FROM OLD.s3_key OR NEW.bucket IS DISTINCT FROM OLD.bucket
     OR (NEW.uploaded_by_user_id IS NOT NULL
       AND NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id))) THEN
   RAISE EXCEPTION 'attachment prospect origin is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER engagement_attachments_preserve_prospect_origin BEFORE UPDATE ON engagement_attachments
 FOR EACH ROW EXECUTE FUNCTION preserve_prospect_attachment_origin();

CREATE FUNCTION preserve_prospect_upload_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'confirmed_attachment_id') IS DISTINCT FROM (to_jsonb(OLD)-'confirmed_attachment_id')
   OR (OLD.confirmed_attachment_id IS NOT NULL AND NEW.confirmed_attachment_id IS DISTINCT FROM OLD.confirmed_attachment_id) THEN
   RAISE EXCEPTION 'prospect upload receipt is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prospect_attachment_upload_intents_immutable BEFORE UPDATE ON prospect_attachment_upload_intents
 FOR EACH ROW EXECUTE FUNCTION preserve_prospect_upload_receipt();
-- Deliberately no FK to confirmed attachment: this is a permanent tombstone after
-- attachment/S3 deletion. No backfill, copy, grant or legacy-row relabeling.
