-- Forward-only cutover. Quiesce both publishers and verify existing runtime role
-- grants before applying. This migration creates no role grants and changes no
-- applied migration. Prisma's historic Workspace timestamp columns contain UTC.
BEGIN;
-- The retired RP table forces RLS even for its non-superuser migration owner.
-- This trusted copy must see every tenant; the bypass clears with this transaction.
SET LOCAL app.bypass_rls = 'on';
LOCK TABLE ws_share_link, research_portfolio_share_links IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM ws_share_link w JOIN research_portfolio_share_links r
             ON w.id = r.id OR w.token_hash = r.token_hash) THEN
    RAISE EXCEPTION 'Canonical share cutover identity/hash collision';
  END IF;
  IF EXISTS (SELECT token_hash FROM ws_share_link GROUP BY token_hash HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Canonical share cutover ambiguous existing token hash';
  END IF;
END $$;

ALTER TABLE ws_share_link
  ALTER COLUMN draft_id DROP NOT NULL,
  ALTER COLUMN expires_at TYPE TIMESTAMPTZ(6) USING expires_at AT TIME ZONE 'UTC',
  ALTER COLUMN revoked_at TYPE TIMESTAMPTZ(6) USING revoked_at AT TIME ZONE 'UTC',
  ALTER COLUMN created_at TYPE TIMESTAMPTZ(6) USING created_at AT TIME ZONE 'UTC',
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'workspace_document',
  ADD COLUMN resource_id UUID,
  ADD COLUMN operation_key VARCHAR(128),
  ADD COLUMN request_hash CHAR(64),
  ADD COLUMN payload JSONB,
  ADD COLUMN payload_hash CHAR(64),
  ADD COLUMN portfolio_id UUID,
  ADD COLUMN client_id UUID,
  ADD COLUMN snapshot_id UUID,
  ADD COLUMN snapshot_name VARCHAR(200),
  ADD COLUMN design_id UUID,
  ADD COLUMN design_version INTEGER,
  ADD COLUMN branding BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN published_by_user_id UUID,
  ADD COLUMN published_at TIMESTAMPTZ(6),
  ADD COLUMN revoked_by_user_id UUID,
  ADD COLUMN revoke_reason VARCHAR(64),
  ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_opened_at TIMESTAMPTZ(6),
  ADD COLUMN failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN locked_until TIMESTAMPTZ(6);

UPDATE ws_share_link SET resource_id = draft_id;
-- Historic Workspace labels are deliberately not interpreted as operation keys.
-- Their old API conflated labels/keys; the wrapper rejects ambiguous legacy retry.
INSERT INTO ws_share_link (
  id, tenant_id, kind, resource_id, created_by_id, token_hash, operation_key,
  payload, payload_hash, created_at, expires_at, revoked_at,
  portfolio_id, client_id, snapshot_id, snapshot_name, design_id, design_version,
  branding, published_by_user_id, published_at, revoked_by_user_id, revoke_reason,
  open_count, last_opened_at, failed_pin_attempts, locked_until
)
SELECT id, tenant_id, 'research_portfolio', portfolio_id, published_by_user_id::text,
  token_hash, operation_key, payload, payload_hash, published_at, expires_at, revoked_at,
  portfolio_id, client_id, snapshot_id, snapshot_name, design_id, design_version,
  branding, published_by_user_id, published_at, revoked_by_user_id, revoke_reason,
  open_count, last_opened_at, failed_pin_attempts, locked_until
FROM research_portfolio_share_links;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM research_portfolio_share_links r LEFT JOIN ws_share_link w ON w.id = r.id
    WHERE w.id IS NULL OR
      (to_jsonb(w) - ARRAY['kind','resource_id','draft_id','created_by_id','version_id','label','request_hash','created_at'])
      IS DISTINCT FROM to_jsonb(r)
  ) OR (SELECT count(*) FROM ws_share_link WHERE kind = 'research_portfolio') <>
       (SELECT count(*) FROM research_portfolio_share_links) THEN
    RAISE EXCEPTION 'Canonical share cutover failed exact portfolio row reconciliation';
  END IF;
END $$;

ALTER TABLE ws_share_link ALTER COLUMN resource_id SET NOT NULL;
ALTER TABLE ws_share_link ADD CONSTRAINT ws_share_link_kind_check CHECK (
  (kind = 'workspace_document' AND draft_id IS NOT NULL AND resource_id = draft_id AND portfolio_id IS NULL)
  OR (kind = 'research_portfolio' AND draft_id IS NULL AND resource_id = portfolio_id
    AND portfolio_id IS NOT NULL AND client_id IS NOT NULL AND snapshot_id IS NOT NULL
    AND snapshot_name IS NOT NULL AND design_version IS NOT NULL
    AND operation_key IS NOT NULL AND payload IS NOT NULL AND payload_hash IS NOT NULL
    AND published_by_user_id IS NOT NULL AND published_at IS NOT NULL
    AND expires_at IS NOT NULL AND expires_at = published_at + INTERVAL '168 hours'
    AND token_hash ~ '^[0-9a-f]{64}$' AND payload_hash ~ '^[0-9a-f]{64}$')
);
ALTER TABLE ws_share_link ADD CONSTRAINT ws_share_link_request_hash_check
  CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE ws_share_link ADD CONSTRAINT ws_share_link_portfolio_fkey
  FOREIGN KEY (tenant_id, portfolio_id) REFERENCES research_portfolios(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE ws_share_link ADD CONSTRAINT ws_share_link_client_fkey
  FOREIGN KEY (tenant_id, client_id) REFERENCES clients(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE ws_share_link ADD CONSTRAINT ws_share_link_design_fkey
  FOREIGN KEY (tenant_id, design_id) REFERENCES research_portfolio_dashboard_designs(tenant_id, id) ON DELETE SET NULL (design_id);
CREATE UNIQUE INDEX ws_share_link_tenant_id_key ON ws_share_link(tenant_id, id);
CREATE UNIQUE INDEX ws_share_link_operation_key ON ws_share_link(tenant_id, kind, resource_id, operation_key);
CREATE UNIQUE INDEX ws_share_link_token_hash_key ON ws_share_link(token_hash);
CREATE INDEX ws_share_link_portfolio_idx ON ws_share_link(tenant_id, portfolio_id, published_at DESC);
CREATE INDEX ws_share_link_expiry_idx ON ws_share_link(tenant_id, expires_at);

-- Preserve Workspace's existing document policy, constrain RP rows for the
-- non-owner Core runtime role. No FORCE change and no new grants are made here.
ALTER TABLE ws_share_link ENABLE ROW LEVEL SECURITY;
CREATE POLICY ws_share_link_kind_isolation ON ws_share_link
  USING (kind = 'workspace_document' OR rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (kind = 'workspace_document' OR rls_bypass() OR tenant_id = current_tenant_id());

-- Retain the old ledger as immutable migration evidence; never run dual writers.
-- Detach parent actions before making the ledger immutable: their historical
-- CASCADE/SET NULL writes would otherwise abort deletion of a live parent.
-- The canonical ws_share_link table retains the live portfolio/client/design FKs.
ALTER TABLE research_portfolio_share_links
  DROP CONSTRAINT research_portfolio_share_links_tenant_id_fkey,
  DROP CONSTRAINT research_portfolio_share_links_portfolio_fkey,
  DROP CONSTRAINT research_portfolio_share_links_client_fkey,
  DROP CONSTRAINT research_portfolio_share_links_design_fkey;
CREATE FUNCTION reject_retired_research_share_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Research shares now use the canonical ws_share_link lifecycle'; END $$;
CREATE TRIGGER research_share_retired_write BEFORE INSERT OR UPDATE OR DELETE
  ON research_portfolio_share_links FOR EACH STATEMENT EXECUTE FUNCTION reject_retired_research_share_write();
COMMIT;
