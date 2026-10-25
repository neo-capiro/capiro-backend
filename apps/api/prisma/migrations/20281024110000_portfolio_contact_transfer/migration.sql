-- The result records only explicit carry-over. Conversion receipts and source
-- contacts are unchanged; history survives later contact edits and deletion.
CREATE TABLE IF NOT EXISTS prospect_contact_transfer_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  prospect_id UUID NOT NULL,
  client_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('completed','refused')),
  result_jsonb JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT prospect_contact_transfer_receipts_pkey PRIMARY KEY (tenant_id,actor_user_id,request_id),
  CHECK ((
    (status='refused' AND result_jsonb IS NULL)
    OR (status='completed' AND result_jsonb IS NOT NULL
      AND jsonb_typeof(result_jsonb)='object' AND result_jsonb ? 'items'
      AND jsonb_typeof(result_jsonb->'items')='array'
      AND jsonb_array_length(result_jsonb->'items') BETWEEN 1 AND 50)
  ) IS TRUE)
);
CREATE OR REPLACE FUNCTION prospect_contact_transfer_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Contact transfer receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS prospect_contact_transfer_receipt_immutable ON prospect_contact_transfer_receipts;
CREATE TRIGGER prospect_contact_transfer_receipt_immutable BEFORE UPDATE ON prospect_contact_transfer_receipts
  FOR EACH ROW EXECUTE FUNCTION prospect_contact_transfer_receipt_immutable();
ALTER TABLE prospect_contact_transfer_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_contact_transfer_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS prospect_contact_transfer_receipts_isolation ON prospect_contact_transfer_receipts;
CREATE POLICY prospect_contact_transfer_receipts_isolation ON prospect_contact_transfer_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON prospect_contact_transfer_receipts TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON prospect_contact_transfer_receipts FROM capiro_app;
  END IF;
END $$;
