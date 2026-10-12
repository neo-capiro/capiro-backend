-- Main API owns these receipts. No foreign key crosses engine ownership:
-- receipts must remain after a Workspace thread/document is removed.
CREATE TABLE newsletter_review_email_deliveries (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  document_id UUID NOT NULL,
  comment_id UUID NOT NULL,
  recipient_id TEXT NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('claimed', 'sending', 'sent', 'failed', 'cancelled', 'outcome_unknown')),
  message_id TEXT,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX newsletter_review_email_deliveries_tenant_id_created_at_idx ON newsletter_review_email_deliveries(tenant_id, created_at);
CREATE INDEX newsletter_review_email_deliveries_status_updated_at_idx ON newsletter_review_email_deliveries(status, updated_at);
ALTER TABLE newsletter_review_email_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_review_email_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY newsletter_review_email_delivery_isolation ON newsletter_review_email_deliveries
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_review_email_deliveries TO capiro_app;
  END IF;
END $$;
