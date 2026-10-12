CREATE TABLE newsletter_account_invitations (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  document_id UUID NOT NULL,
  author_id TEXT NOT NULL,
  email VARCHAR(320) NOT NULL,
  organization_id TEXT NOT NULL,
  account_role TEXT NOT NULL CHECK (account_role IN ('member', 'admin')),
  status VARCHAR(32) NOT NULL CHECK (status IN ('checking', 'sending', 'invited', 'reused', 'member_ready', 'role_conflict', 'admin_required', 'waiting', 'expired', 'revoked', 'cancelled', 'failed', 'outcome_unknown')),
  provider_invitation_id TEXT,
  provider_role TEXT,
  attempted_at TIMESTAMPTZ,
  attempt_kind TEXT CHECK (attempt_kind IN ('create_invitation', 'promote_member')),
  lease_id UUID,
  error_code VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((attempted_at IS NULL) = (attempt_kind IS NULL))
);
CREATE INDEX newsletter_account_invitation_email_idx ON newsletter_account_invitations(tenant_id, email, organization_id);
CREATE INDEX newsletter_account_invitation_document_idx ON newsletter_account_invitations(tenant_id, document_id);
ALTER TABLE newsletter_account_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_account_invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY newsletter_account_invitation_isolation ON newsletter_account_invitations
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON newsletter_account_invitations TO capiro_app;
  END IF;
END $$;
