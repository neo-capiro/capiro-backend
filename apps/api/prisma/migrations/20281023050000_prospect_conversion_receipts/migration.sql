-- Source-only PF18 receipt for an explicitly reviewed existing-client link.
-- No transfers or new client-capacity policy is introduced by this migration.
CREATE TABLE IF NOT EXISTS prospect_conversion_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  prospect_id UUID NOT NULL,
  client_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object'),
  receipt JSONB NOT NULL CHECK (jsonb_typeof(receipt)='object'),
  committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT prospect_conversion_receipts_request_key UNIQUE (tenant_id,actor_user_id,request_id),
  CONSTRAINT prospect_conversion_receipts_prospect_fk FOREIGN KEY (tenant_id,prospect_id)
    REFERENCES business_development_prospects(tenant_id,id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT prospect_conversion_receipts_client_fk FOREIGN KEY (tenant_id,client_id)
    REFERENCES clients(tenant_id,id) ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE OR REPLACE FUNCTION prospect_conversion_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Prospect conversion receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS prospect_conversion_receipts_immutable ON prospect_conversion_receipts;
CREATE TRIGGER prospect_conversion_receipts_immutable BEFORE UPDATE ON prospect_conversion_receipts
  FOR EACH ROW EXECUTE FUNCTION prospect_conversion_receipt_immutable();
ALTER TABLE prospect_conversion_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_conversion_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospect_conversion_receipts_isolation ON prospect_conversion_receipts;
CREATE POLICY prospect_conversion_receipts_isolation ON prospect_conversion_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON prospect_conversion_receipts TO capiro_app;
    REVOKE UPDATE,DELETE ON prospect_conversion_receipts FROM capiro_app;
  END IF;
END $$;
