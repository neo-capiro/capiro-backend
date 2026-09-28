-- Additive, client-private immutable fit provenance. No generic event payloads.
CREATE TABLE research_portfolio_fit_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  portfolio_id UUID NOT NULL,
  client_id UUID NOT NULL,
  basis_fingerprint CHAR(64) NOT NULL CHECK (basis_fingerprint ~ '^[0-9a-f]{64}$'),
  calculation_version VARCHAR(64) NOT NULL,
  portfolio_revision INTEGER NOT NULL CHECK (portfolio_revision > 0),
  projection JSONB NOT NULL,
  input_basis JSONB NOT NULL,
  created_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT research_portfolio_fit_versions_tenant_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  CONSTRAINT research_portfolio_fit_versions_author_fkey FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CONSTRAINT research_portfolio_fit_versions_portfolio_fkey FOREIGN KEY (tenant_id, portfolio_id) REFERENCES research_portfolios(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT research_portfolio_fit_versions_client_fkey FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT research_portfolio_fit_versions_basis_key UNIQUE (tenant_id,portfolio_id,client_id,basis_fingerprint)
);
CREATE INDEX research_portfolio_fit_versions_history_idx ON research_portfolio_fit_versions(tenant_id,portfolio_id,client_id,created_at DESC);
CREATE FUNCTION research_portfolio_fit_versions_immutable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Research portfolio fit versions are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER research_portfolio_fit_versions_immutable BEFORE UPDATE OR DELETE ON research_portfolio_fit_versions FOR EACH ROW EXECUTE FUNCTION research_portfolio_fit_versions_immutable_guard();
ALTER TABLE research_portfolio_fit_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_fit_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY research_portfolio_fit_versions_read ON research_portfolio_fit_versions FOR SELECT USING (
  rls_bypass() OR (
    tenant_id=current_tenant_id()
    AND EXISTS(SELECT 1 FROM research_portfolio_grants g WHERE g.tenant_id=research_portfolio_fit_versions.tenant_id AND g.portfolio_id=research_portfolio_fit_versions.portfolio_id AND g.principal_user_id=current_user_id())
    AND (
      EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=research_portfolio_fit_versions.tenant_id AND c.id=research_portfolio_fit_versions.client_id AND NOT c.memory_wall)
      OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=research_portfolio_fit_versions.tenant_id AND a.client_id=research_portfolio_fit_versions.client_id AND a.user_id=current_user_id())
    )
  )
);
CREATE POLICY research_portfolio_fit_versions_insert ON research_portfolio_fit_versions FOR INSERT WITH CHECK (
  rls_bypass() OR (
    tenant_id=current_tenant_id() AND created_by_user_id=current_user_id()
    AND EXISTS(SELECT 1 FROM research_portfolio_grants g WHERE g.tenant_id=research_portfolio_fit_versions.tenant_id AND g.portfolio_id=research_portfolio_fit_versions.portfolio_id AND g.principal_user_id=current_user_id() AND g.role IN ('editor','owner'))
    AND (
      EXISTS(SELECT 1 FROM clients c WHERE c.tenant_id=research_portfolio_fit_versions.tenant_id AND c.id=research_portfolio_fit_versions.client_id AND NOT c.memory_wall)
      OR EXISTS(SELECT 1 FROM client_memory_access a WHERE a.tenant_id=research_portfolio_fit_versions.tenant_id AND a.client_id=research_portfolio_fit_versions.client_id AND a.user_id=current_user_id())
    )
  )
);
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    GRANT SELECT, INSERT ON research_portfolio_fit_versions TO capiro_app;
  END IF;
END;
$$;
