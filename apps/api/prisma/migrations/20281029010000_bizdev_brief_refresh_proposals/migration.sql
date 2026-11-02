-- Exact reviewed proposals. Content is immutable; acceptance uses the existing
-- brief version ledger and its unique idempotency key, in the root transaction.
CREATE TABLE business_development_brief_refresh_proposals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  brief_id uuid NOT NULL,
  base_version_id uuid NOT NULL,
  created_by_user_id uuid NOT NULL,
  payload jsonb NOT NULL,
  proposal_hash varchar(64) NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT brief_refresh_base_fkey FOREIGN KEY (tenant_id,base_version_id,brief_id)
    REFERENCES business_development_brief_versions(tenant_id,id,brief_id) ON DELETE CASCADE,
  CONSTRAINT brief_refresh_identity_check CHECK ((
    payload->>'proposalId'=id::text AND payload->>'tenantId'=tenant_id::text
    AND payload->>'briefId'=brief_id::text AND payload->>'baseVersionId'=base_version_id::text
    AND payload->>'createdByUserId'=created_by_user_id::text AND payload->>'proposalHash'=proposal_hash
    AND octet_length(payload::text) <= 262144) IS TRUE)
);
CREATE INDEX brief_refresh_owner_idx ON business_development_brief_refresh_proposals(tenant_id,brief_id,created_by_user_id,created_at DESC);
ALTER TABLE business_development_brief_refresh_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_development_brief_refresh_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY brief_refresh_isolation ON business_development_brief_refresh_proposals
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON business_development_brief_refresh_proposals FROM capiro_app;
    GRANT SELECT,INSERT ON business_development_brief_refresh_proposals TO capiro_app;
  END IF;
END $$;

