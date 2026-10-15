-- Centrally allocated source-only canonical reservation. No migration executed.
ALTER TABLE client_objective_work_intents
  ADD CONSTRAINT client_objective_work_intents_canonical_scope_key
  UNIQUE (tenant_id, client_id, objective_id, id,
          objective_revision_id, objective_version, snapshot_hash);

CREATE TABLE client_objective_canonical_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  canonical_strategy_id UUID NOT NULL UNIQUE,
  canonical_project_id UUID NOT NULL UNIQUE,
  binding_version INTEGER NOT NULL DEFAULT 1 CHECK (binding_version > 0),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch = 1),
  requested_intent_id UUID NOT NULL,
  requested_objective_revision_id UUID NOT NULL,
  requested_objective_version INTEGER NOT NULL CHECK (requested_objective_version > 0),
  requested_snapshot_hash CHAR(64) NOT NULL CHECK (requested_snapshot_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT client_objective_canonical_plans_objective_key
    UNIQUE (tenant_id, client_id, objective_id),
  CONSTRAINT client_objective_canonical_plans_intent_fk
    FOREIGN KEY (tenant_id, client_id, objective_id, requested_intent_id,
                 requested_objective_revision_id, requested_objective_version, requested_snapshot_hash)
    REFERENCES client_objective_work_intents
      (tenant_id, client_id, objective_id, id, objective_revision_id, objective_version, snapshot_hash)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

-- No FK to Strategy/project output tables: UUID reservations are not output rows.
ALTER TABLE client_objective_canonical_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_canonical_plans FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_canonical_plans_isolation ON client_objective_canonical_plans
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- Existing 20260502020000 default privileges supply SELECT/INSERT/UPDATE when
-- migrations run as that configured owner. No GRANT, role or default privilege
-- expansion here. Actual owner/inheritance/RLS/privileges need native proof.
-- Narrow direct DELETE inherited from that policy; parent Objective deletion
-- still cascades through its revision and intent, preserving existing semantics.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE DELETE ON client_objective_canonical_plans FROM capiro_app;
  END IF;
END $$;
