-- Content-free owner-local outcomes. No cascading FK, content copy or backfill.
CREATE TABLE ws_newsletter_write_receipt (
  tenant_id UUID NOT NULL, actor_id TEXT NOT NULL, request_id UUID NOT NULL,
  operation TEXT NOT NULL, document_id UUID NOT NULL,
  previous_revision INTEGER, revision INTEGER NOT NULL,
  input_hash VARCHAR(64) NOT NULL, content_hash VARCHAR(64) NOT NULL,
  source_client_ids UUID[] NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ws_newsletter_write_receipt_pkey PRIMARY KEY (tenant_id,actor_id,request_id),
  CONSTRAINT ws_newsletter_write_receipt_revision CHECK (
    (operation='create' AND previous_revision IS NULL AND revision=1) OR
    (operation='save' AND previous_revision IS NOT NULL AND previous_revision >= 1 AND revision=previous_revision+1)),
  CONSTRAINT ws_newsletter_write_receipt_hashes CHECK (
    input_hash ~ '^[a-f0-9]{64}$' AND content_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE ws_newsletter_write_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE ws_newsletter_write_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY ws_newsletter_write_receipt_isolation ON ws_newsletter_write_receipt
  USING (tenant_id=NULLIF(current_setting('app.current_tenant',true),'')::uuid)
  WITH CHECK (tenant_id=NULLIF(current_setting('app.current_tenant',true),'')::uuid);
GRANT SELECT,INSERT ON ws_newsletter_write_receipt TO capiro_app;
REVOKE UPDATE,DELETE,TRUNCATE ON ws_newsletter_write_receipt FROM capiro_app;
CREATE FUNCTION ws_newsletter_write_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NEWSLETTER_WRITE_RECEIPT_IMMUTABLE' USING ERRCODE='23514'; END $$;
CREATE TRIGGER ws_newsletter_write_receipt_immutable BEFORE UPDATE OR DELETE ON ws_newsletter_write_receipt
  FOR EACH ROW EXECUTE FUNCTION ws_newsletter_write_receipt_immutable();
