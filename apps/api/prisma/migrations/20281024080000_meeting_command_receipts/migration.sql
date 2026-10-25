-- One immutable outcome for a reviewed meeting/artifact command. Historical
-- identity survives subsequent meeting/artifact edits and removal.
CREATE TABLE IF NOT EXISTS meeting_command_receipts (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  operation TEXT NOT NULL CHECK (operation IN (
    'create','update','note-create','note-update','note-approve',
    'debrief-create','debrief-update','debrief-approve','share','unshare'
  )),
  requested_meeting_id UUID,
  expected_client_id UUID,
  client_ids UUID[] NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','refused')),
  result_jsonb JSONB,
  message TEXT,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT meeting_command_receipts_pkey PRIMARY KEY (tenant_id,actor_user_id,request_id),
  CHECK ((operation='create' AND requested_meeting_id IS NULL AND expected_client_id IS NULL)
    OR (operation<>'create' AND requested_meeting_id IS NOT NULL)),
  CHECK (cardinality(client_ids)<=3 AND array_position(client_ids,NULL) IS NULL),
  CHECK (expected_client_id IS NULL OR expected_client_id=ANY(client_ids)),
  CHECK (
    (status='refused' AND result_jsonb IS NULL AND message IS NOT NULL AND length(message) BETWEEN 1 AND 500)
    OR (status='completed' AND message IS NULL AND result_jsonb IS NOT NULL
      AND jsonb_typeof(result_jsonb)='object'
      AND result_jsonb ?& ARRAY['meetingId','clientId','revision','artifacts']
      AND jsonb_typeof(result_jsonb->'meetingId')='string'
      AND (requested_meeting_id IS NULL OR result_jsonb->>'meetingId'=requested_meeting_id::text)
      AND jsonb_typeof(result_jsonb->'revision')='string'
      AND jsonb_typeof(result_jsonb->'artifacts')='array'
      AND jsonb_array_length(result_jsonb->'artifacts')<=50)
  )
);
CREATE OR REPLACE FUNCTION meeting_command_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Meeting command receipt is immutable' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS meeting_command_receipt_immutable ON meeting_command_receipts;
CREATE TRIGGER meeting_command_receipt_immutable BEFORE UPDATE ON meeting_command_receipts
  FOR EACH ROW EXECUTE FUNCTION meeting_command_receipt_immutable();
ALTER TABLE meeting_command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_command_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meeting_command_receipts_isolation ON meeting_command_receipts;
CREATE POLICY meeting_command_receipts_isolation ON meeting_command_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT,INSERT ON meeting_command_receipts TO capiro_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON meeting_command_receipts FROM capiro_app;
  END IF;
END $$;
