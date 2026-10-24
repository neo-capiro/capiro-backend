-- Immutable internal support requests. No attachment or run-content storage.
-- Tenant/user erasure cascades through the existing canonical lifecycle.
CREATE TABLE support_requests (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  submitted_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  summary varchar(200) NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 200),
  detail varchar(5000) NOT NULL CHECK (char_length(btrim(detail)) BETWEEN 1 AND 5000),
  run_reference varchar(200) CHECK (run_reference IS NULL OR char_length(btrim(run_reference)) BETWEEN 1 AND 200),
  created_at timestamptz(6) NOT NULL DEFAULT now()
);
CREATE INDEX support_requests_tenant_created_idx ON support_requests (tenant_id, created_at DESC, id DESC);
ALTER TABLE support_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY support_requests_isolation ON support_requests
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

CREATE FUNCTION reject_support_request_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Support requests are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER support_requests_immutable BEFORE UPDATE ON support_requests
  FOR EACH ROW EXECUTE FUNCTION reject_support_request_update();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, DELETE ON support_requests TO capiro_app;
  END IF;
END $$;
