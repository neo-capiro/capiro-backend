ALTER TABLE client_objective_revisions ADD CONSTRAINT client_objective_revisions_intent_scope_key
  UNIQUE (tenant_id, client_id, objective_id, id, version);

CREATE TABLE client_objective_work_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  objective_revision_id UUID NOT NULL,
  objective_version INTEGER NOT NULL CHECK (objective_version > 0),
  actor_user_id UUID NOT NULL,
  purpose VARCHAR(40) NOT NULL CHECK (purpose = 'objective_strategy_plan'),
  snapshot_hash CHAR(64) NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  state VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  blocked_reason VARCHAR(48) NOT NULL DEFAULT 'runtime_authority_unconnected'
    CHECK (blocked_reason = 'runtime_authority_unconnected'),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_objective_work_intents_revision_fk
    FOREIGN KEY (tenant_id, client_id, objective_id, objective_revision_id, objective_version)
    REFERENCES client_objective_revisions(tenant_id, client_id, objective_id, id, version)
    ON DELETE CASCADE,
  CONSTRAINT client_objective_work_intents_purpose_key
    UNIQUE (tenant_id, client_id, objective_id, objective_revision_id, purpose)
);

ALTER TABLE client_objective_work_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_work_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_work_intents_isolation ON client_objective_work_intents
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE UPDATE, DELETE ON client_objective_work_intents FROM capiro_app;
    GRANT SELECT, INSERT ON client_objective_work_intents TO capiro_app;
  END IF;
END $$;
