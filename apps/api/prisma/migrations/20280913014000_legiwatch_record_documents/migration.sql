CREATE TABLE legiwatch_record_document (
  attachment_id UUID PRIMARY KEY REFERENCES engagement_attachments(id) ON DELETE RESTRICT,
  tenant_id UUID NOT NULL,owner_clerk_id TEXT NOT NULL,client_id UUID NOT NULL,
  event_id TEXT NOT NULL,brief_id TEXT NOT NULL,series_id TEXT NOT NULL,version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,source_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,owner_clerk_id,brief_id,content_hash)
);
ALTER TABLE legiwatch_record_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE legiwatch_record_document FORCE ROW LEVEL SECURITY;
CREATE POLICY record_document_tenant ON legiwatch_record_document USING(tenant_id=current_tenant_id()) WITH CHECK(tenant_id=current_tenant_id());
GRANT SELECT,INSERT ON legiwatch_record_document TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON legiwatch_record_document FROM capiro_app;
CREATE TRIGGER record_document_immutable BEFORE UPDATE ON legiwatch_record_document FOR EACH ROW EXECUTE FUNCTION legiwatch_reject_record_rewrite();
