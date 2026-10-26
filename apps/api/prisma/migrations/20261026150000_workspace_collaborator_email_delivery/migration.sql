-- One receipt per explicit ordinary invitation mail action. It intentionally
-- outlives ws_collaborator deletion, preserving accepted/uncertain attempts.
CREATE TABLE workspace_collaborator_email_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  requested_by TEXT NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('claimed','sending','accepted','disabled','failed','cancelled','outcome_unknown')),
  message_id TEXT,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_collaborator_email_acceptance CHECK (
    (status='accepted' AND message_id IS NOT NULL AND length(trim(message_id))>0)
    OR (status<>'accepted' AND message_id IS NULL)
  )
);
CREATE INDEX workspace_collaborator_email_deliveries_tenant_id_draft_id_idx
  ON workspace_collaborator_email_deliveries(tenant_id,draft_id);
ALTER TABLE workspace_collaborator_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_collaborator_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_collaborator_email_isolation ON workspace_collaborator_email_deliveries
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
REVOKE ALL ON workspace_collaborator_email_deliveries FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE DELETE, TRUNCATE ON workspace_collaborator_email_deliveries FROM capiro_app;
    GRANT SELECT, INSERT, UPDATE ON workspace_collaborator_email_deliveries TO capiro_app;
  END IF;
END $$;
