-- Historical outcomes survive later file edits/deletion and ACL self-removal.
-- The application always rechecks the current actor and client before reading.
CREATE TABLE IF NOT EXISTS client_file_access_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  client_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN ('file-access','folder-access')),
  status TEXT NOT NULL CHECK (status IN ('completed','refused')),
  result_jsonb JSONB,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT client_file_access_receipts_pkey PRIMARY KEY (tenant_id,actor_user_id,request_id),
  CHECK ((
    (status='refused' AND result_jsonb IS NULL)
    OR (status='completed' AND result_jsonb IS NOT NULL
      AND jsonb_typeof(result_jsonb)='object' AND result_jsonb ? 'files'
      AND jsonb_typeof(result_jsonb->'files')='array'
      AND jsonb_array_length(result_jsonb->'files') BETWEEN 1 AND 100
      AND (operation='folder-access' OR jsonb_array_length(result_jsonb->'files')=1))
  ) IS TRUE)
);
CREATE OR REPLACE FUNCTION client_file_access_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'File access receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS client_file_access_receipt_immutable ON client_file_access_receipts;
CREATE TRIGGER client_file_access_receipt_immutable BEFORE UPDATE ON client_file_access_receipts
  FOR EACH ROW EXECUTE FUNCTION client_file_access_receipt_immutable();
ALTER TABLE client_file_access_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_file_access_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS client_file_access_receipts_isolation ON client_file_access_receipts;
CREATE POLICY client_file_access_receipts_isolation ON client_file_access_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON client_file_access_receipts TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON client_file_access_receipts FROM capiro_app;
  END IF;
END $$;
