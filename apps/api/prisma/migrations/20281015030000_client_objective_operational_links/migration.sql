-- Source-only, coordinated Objective lane. No resource row or permission is created.
CREATE TABLE client_objective_operational_states (
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, client_id, objective_id),
  CONSTRAINT client_objective_operational_states_objective_fk FOREIGN KEY (tenant_id, client_id, objective_id)
    REFERENCES client_objectives(tenant_id, client_id, id) ON DELETE CASCADE
);

CREATE TABLE client_objective_resource_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  linked_revision_id UUID NOT NULL,
  linked_objective_version INTEGER NOT NULL CHECK (linked_objective_version > 0),
  resource_kind VARCHAR(32) NOT NULL CHECK (resource_kind IN
    ('strategy','planner_project','planner_task','outreach_session','meeting')),
  resource_id UUID NOT NULL,
  cycles JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(cycles) = 'array'),
  linked_by_user_id UUID NOT NULL,
  linked_at TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ(6),
  removed_by_user_id UUID,
  removed_request_id UUID,
  CONSTRAINT client_objective_resource_links_tombstone CHECK (
    (removed_at IS NULL AND removed_by_user_id IS NULL AND removed_request_id IS NULL) OR
    (removed_at IS NOT NULL AND removed_by_user_id IS NOT NULL AND removed_request_id IS NOT NULL)),
  CONSTRAINT client_objective_resource_links_revision_fk
    FOREIGN KEY (tenant_id,client_id,objective_id,linked_revision_id,linked_objective_version)
    REFERENCES client_objective_revisions(tenant_id,client_id,objective_id,id,version)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_objective_resource_links_receipt_key
    UNIQUE (tenant_id,client_id,objective_id,id,linked_revision_id,linked_objective_version)
);
CREATE UNIQUE INDEX client_objective_resource_links_active_key ON client_objective_resource_links
  (tenant_id,client_id,objective_id,resource_kind,resource_id) WHERE removed_at IS NULL;
CREATE INDEX client_objective_resource_links_list_idx ON client_objective_resource_links
  (tenant_id,client_id,objective_id,removed_at,id);

CREATE TABLE client_objective_operational_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  client_id UUID NOT NULL,
  objective_id UUID NOT NULL,
  actor_user_id UUID NOT NULL,
  request_id UUID NOT NULL,
  payload_digest CHAR(64) NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  command JSONB NOT NULL CHECK (jsonb_typeof(command)='object'),
  association_id UUID NOT NULL,
  command_revision_id UUID NOT NULL,
  command_objective_version INTEGER NOT NULL CHECK (command_objective_version > 0),
  linked_revision_id UUID NOT NULL,
  linked_objective_version INTEGER NOT NULL,
  action VARCHAR(8) NOT NULL CHECK (action IN ('link','unlink')),
  outcome VARCHAR(12) NOT NULL,
  result_set_version INTEGER NOT NULL CHECK (result_set_version >= 0),
  committed_at TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT client_objective_operational_receipts_outcome CHECK (
    (action='link' AND outcome IN ('linked','unchanged')) OR
    (action='unlink' AND outcome IN ('unlinked','unchanged'))),
  CONSTRAINT client_objective_operational_receipts_request_key
    UNIQUE (tenant_id,client_id,objective_id,actor_user_id,request_id),
  CONSTRAINT client_objective_operational_receipts_revision_fk
    FOREIGN KEY (tenant_id,client_id,objective_id,command_revision_id,command_objective_version)
    REFERENCES client_objective_revisions(tenant_id,client_id,objective_id,id,version)
    ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT client_objective_operational_receipts_link_fk
    FOREIGN KEY (tenant_id,client_id,objective_id,association_id,linked_revision_id,linked_objective_version)
    REFERENCES client_objective_resource_links
      (tenant_id,client_id,objective_id,id,linked_revision_id,linked_objective_version)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

-- A membership identity never changes its source/revision/annotation, including
-- after unlink. Re-link creates a new immutable identity. Tombstones are one-way.
CREATE FUNCTION objective_resource_link_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['removed_at','removed_by_user_id','removed_request_id'])
       IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['removed_at','removed_by_user_id','removed_request_id'])
     OR OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'Objective association identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER client_objective_resource_links_immutable BEFORE UPDATE
  ON client_objective_resource_links FOR EACH ROW EXECUTE FUNCTION objective_resource_link_immutable();
CREATE FUNCTION objective_operational_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Objective association receipt is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER client_objective_operational_receipts_immutable BEFORE UPDATE
  ON client_objective_operational_receipts FOR EACH ROW EXECUTE FUNCTION objective_operational_receipt_immutable();

ALTER TABLE client_objective_operational_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_operational_states FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_operational_states_isolation ON client_objective_operational_states
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_resource_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_resource_links FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_resource_links_isolation ON client_objective_resource_links
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());
ALTER TABLE client_objective_operational_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_objective_operational_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY client_objective_operational_receipts_isolation ON client_objective_operational_receipts
  USING (rls_bypass() OR tenant_id=current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id=current_tenant_id());

-- No new role or default privileges. Actual role inheritance/grants need native proof.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE DELETE ON client_objective_operational_states,client_objective_resource_links FROM capiro_app;
    REVOKE UPDATE,DELETE ON client_objective_operational_receipts FROM capiro_app;
  END IF;
END $$;
