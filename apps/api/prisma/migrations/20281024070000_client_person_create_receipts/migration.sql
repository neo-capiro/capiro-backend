-- Manual contact creation consumes its request in the contact's transaction.
-- No person/client FK: deleting or editing a contact must not release its key.
CREATE TABLE IF NOT EXISTS client_person_create_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  client_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  person_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT client_person_create_receipts_pkey PRIMARY KEY (tenant_id,actor_user_id,client_id,request_id)
);
CREATE OR REPLACE FUNCTION client_person_create_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Contact creation receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS client_person_create_receipt_immutable ON client_person_create_receipts;
CREATE TRIGGER client_person_create_receipt_immutable BEFORE UPDATE ON client_person_create_receipts
  FOR EACH ROW EXECUTE FUNCTION client_person_create_receipt_immutable();
ALTER TABLE client_person_create_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_person_create_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_person_create_receipts_isolation ON client_person_create_receipts;
CREATE POLICY client_person_create_receipts_isolation ON client_person_create_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON client_person_create_receipts TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON client_person_create_receipts FROM capiro_app;
  END IF;
END $$;
