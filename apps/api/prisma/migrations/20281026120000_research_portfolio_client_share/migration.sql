-- Research Portfolio client share links: PIN-protected, one-week, frozen dashboard payloads.
-- Sharing is off per portfolio until an Owner turns it on with a PIN (stored as a salted scrypt hash).

ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_enabled';
ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_disabled';
ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_pin_changed';
ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_design_saved';
ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_link_published';
ALTER TYPE research_portfolio_event_kind ADD VALUE IF NOT EXISTS 'share_link_revoked';

CREATE TABLE research_portfolio_share_settings (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  pin_hash VARCHAR(256),
  pin_updated_at TIMESTAMPTZ(6),
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT research_portfolio_share_settings_pkey PRIMARY KEY (tenant_id, portfolio_id),
  CONSTRAINT research_portfolio_share_settings_portfolio_fkey FOREIGN KEY (tenant_id, portfolio_id)
    REFERENCES research_portfolios(tenant_id, id) ON DELETE CASCADE,
  -- No link can exist without a PIN: sharing can only be on when a PIN hash is set.
  CONSTRAINT research_portfolio_share_settings_pin_when_enabled CHECK (enabled = FALSE OR pin_hash IS NOT NULL)
);
CREATE UNIQUE INDEX research_portfolio_share_settings_portfolio_key ON research_portfolio_share_settings(portfolio_id);

CREATE TABLE research_portfolio_dashboard_designs (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL,
  name VARCHAR(200) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  layout JSONB NOT NULL,
  created_by_user_id UUID NOT NULL,
  updated_by_user_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT research_portfolio_dashboard_designs_portfolio_fkey FOREIGN KEY (tenant_id, portfolio_id)
    REFERENCES research_portfolios(tenant_id, id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(layout) = 'object' AND jsonb_typeof(layout->'widgets') = 'array')
);
CREATE UNIQUE INDEX research_portfolio_dashboard_designs_tenant_id_key ON research_portfolio_dashboard_designs(tenant_id, id);
CREATE INDEX research_portfolio_dashboard_designs_portfolio_idx ON research_portfolio_dashboard_designs(tenant_id, portfolio_id, updated_at DESC);

CREATE TABLE research_portfolio_share_links (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL,
  client_id UUID NOT NULL,
  snapshot_id UUID NOT NULL,
  snapshot_name VARCHAR(200) NOT NULL,
  design_id UUID,
  design_version INTEGER NOT NULL,
  branding BOOLEAN NOT NULL DEFAULT FALSE,
  operation_key VARCHAR(128) NOT NULL,
  token_hash CHAR(64) NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  payload JSONB NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  published_by_user_id UUID NOT NULL,
  published_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  revoked_at TIMESTAMPTZ(6),
  revoked_by_user_id UUID,
  revoke_reason VARCHAR(64),
  open_count INTEGER NOT NULL DEFAULT 0,
  last_opened_at TIMESTAMPTZ(6),
  failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ(6),
  CONSTRAINT research_portfolio_share_links_portfolio_fkey FOREIGN KEY (tenant_id, portfolio_id)
    REFERENCES research_portfolios(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT research_portfolio_share_links_client_fkey FOREIGN KEY (tenant_id, client_id)
    REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT research_portfolio_share_links_design_fkey FOREIGN KEY (tenant_id, design_id)
    REFERENCES research_portfolio_dashboard_designs(tenant_id, id) ON DELETE SET NULL,
  -- Fixed one-week lifetime, never extended.
  CHECK (expires_at = published_at + INTERVAL '7 days')
);
CREATE UNIQUE INDEX research_portfolio_share_links_tenant_id_key ON research_portfolio_share_links(tenant_id, id);
CREATE UNIQUE INDEX research_portfolio_share_links_operation_key ON research_portfolio_share_links(tenant_id, operation_key);
CREATE UNIQUE INDEX research_portfolio_share_links_token_hash_key ON research_portfolio_share_links(token_hash);
CREATE INDEX research_portfolio_share_links_portfolio_idx ON research_portfolio_share_links(tenant_id, portfolio_id, published_at DESC);
CREATE INDEX research_portfolio_share_links_expiry_idx ON research_portfolio_share_links(tenant_id, expires_at);

ALTER TABLE research_portfolio_share_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_dashboard_designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_share_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_share_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_dashboard_designs FORCE ROW LEVEL SECURITY;
ALTER TABLE research_portfolio_share_links FORCE ROW LEVEL SECURITY;
CREATE POLICY research_portfolio_share_settings_isolation ON research_portfolio_share_settings
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY research_portfolio_dashboard_designs_isolation ON research_portfolio_dashboard_designs
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
CREATE POLICY research_portfolio_share_links_isolation ON research_portfolio_share_links
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON research_portfolio_share_settings TO capiro_app;
    GRANT SELECT, INSERT, UPDATE ON research_portfolio_dashboard_designs TO capiro_app;
    GRANT SELECT, INSERT, UPDATE ON research_portfolio_share_links TO capiro_app;
    REVOKE DELETE, TRUNCATE ON research_portfolio_share_settings, research_portfolio_dashboard_designs, research_portfolio_share_links FROM capiro_app;
  END IF;
END $$;
