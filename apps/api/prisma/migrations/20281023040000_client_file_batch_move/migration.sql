-- Source-only PF16. Folders remain labels; no folder object, S3 copy or ACL inheritance.
ALTER TABLE engagement_attachments ADD COLUMN IF NOT EXISTS metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK (metadata_revision >= 0);
CREATE OR REPLACE FUNCTION client_file_metadata_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- All actual attachment-column changes participate, including every current
  -- viewerMode/viewerUserIds/uploader, lifecycle and filing writer. No browser
  -- or individual legacy writer can omit an increment or choose a revision.
  IF (to_jsonb(NEW) - 'metadata_revision') IS DISTINCT FROM (to_jsonb(OLD) - 'metadata_revision') THEN
    NEW.metadata_revision := OLD.metadata_revision + 1;
  ELSE
    NEW.metadata_revision := OLD.metadata_revision;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS engagement_attachments_metadata_revision ON engagement_attachments;
CREATE TRIGGER engagement_attachments_metadata_revision BEFORE UPDATE ON engagement_attachments
  FOR EACH ROW EXECUTE FUNCTION client_file_metadata_revision();

CREATE TABLE IF NOT EXISTS client_file_batch_move_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object'),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_file_batch_move_receipts_request_key UNIQUE (tenant_id,actor_user_id,request_id),
  CONSTRAINT client_file_batch_move_receipts_client_fk FOREIGN KEY (tenant_id,client_id)
    REFERENCES clients(tenant_id,id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE OR REPLACE FUNCTION client_file_batch_move_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'File batch move receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS client_file_batch_move_receipts_immutable ON client_file_batch_move_receipts;
CREATE TRIGGER client_file_batch_move_receipts_immutable BEFORE UPDATE ON client_file_batch_move_receipts
  FOR EACH ROW EXECUTE FUNCTION client_file_batch_move_receipt_immutable();
ALTER TABLE client_file_batch_move_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_file_batch_move_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_file_batch_move_receipts_isolation ON client_file_batch_move_receipts;
CREATE POLICY client_file_batch_move_receipts_isolation ON client_file_batch_move_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON client_file_batch_move_receipts TO capiro_app;
    REVOKE UPDATE,DELETE ON client_file_batch_move_receipts FROM capiro_app;
  END IF;
END $$;
