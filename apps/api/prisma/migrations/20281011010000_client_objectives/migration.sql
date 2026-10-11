-- Standalone Objectives. Additive only; no existing client/strategy rows change.
CREATE TABLE client_objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL,
  client_request_id UUID NOT NULL,
  create_request_hash CHAR(64) NOT NULL,
  outcome VARCHAR(2000) NOT NULL DEFAULT '',
  government_problem VARCHAR(4000) NOT NULL DEFAULT '',
  ask_type VARCHAR(32),
  minimum_win VARCHAR(2000) NOT NULL DEFAULT '',
  limits VARCHAR(4000) NOT NULL DEFAULT '',
  owner_user_id UUID,
  created_by_user_id UUID NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  ready_at TIMESTAMPTZ(6),
  review_requested_at TIMESTAMPTZ(6),
  deleted_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_objectives_client_fkey FOREIGN KEY (tenant_id, client_id)
    REFERENCES clients(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT client_objectives_scope_key UNIQUE (tenant_id, client_id, id),
  CONSTRAINT client_objectives_request_key UNIQUE (tenant_id, client_id, client_request_id),
  CONSTRAINT client_objectives_status_check CHECK (status IN ('draft', 'in_review', 'ready')),
  CONSTRAINT client_objectives_ask_check CHECK (ask_type IS NULL OR ask_type IN
    ('funding', 'policy_authority', 'both', 'protect_funding', 'meri_propose')),
  CONSTRAINT client_objectives_ready_check CHECK (status = 'draft' OR (
    length(btrim(outcome)) > 0 AND length(btrim(government_problem)) > 0
    AND ask_type IS NOT NULL AND length(btrim(minimum_win)) > 0))
);
CREATE INDEX client_objectives_list_idx ON client_objectives(tenant_id, client_id, deleted_at, created_at);

CREATE TABLE client_objective_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  operation VARCHAR(32) NOT NULL,
  actor_user_id UUID NOT NULL,
  snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_objective_revisions_objective_fkey FOREIGN KEY (tenant_id, client_id, objective_id)
    REFERENCES client_objectives(tenant_id, client_id, id) ON DELETE CASCADE,
  CONSTRAINT client_objective_revisions_version_key UNIQUE (tenant_id, objective_id, version)
);

ALTER TABLE client_objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objectives FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objectives_isolation ON client_objectives
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
ALTER TABLE client_objective_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_revisions_isolation ON client_objective_revisions
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_objectives TO capiro_app;
    REVOKE UPDATE, DELETE ON client_objective_revisions FROM capiro_app;
    GRANT SELECT, INSERT ON client_objective_revisions TO capiro_app;
  END IF;
END $$;
