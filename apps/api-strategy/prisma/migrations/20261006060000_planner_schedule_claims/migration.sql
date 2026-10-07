CREATE UNIQUE INDEX sp_planner_resources_tenant_id_id_key ON sp_planner_resources(tenant_id, id);
CREATE TABLE sp_planner_schedule_claims (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  task_id UUID NOT NULL,
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  deadline_key CHAR(64) NOT NULL CHECK (deadline_key ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sp_planner_schedule_claims_execution_key UNIQUE (tenant_id, resource_id, task_id, fingerprint, deadline_key),
  CONSTRAINT sp_planner_schedule_claims_resource_fkey FOREIGN KEY (tenant_id, resource_id)
    REFERENCES sp_planner_resources(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT sp_planner_schedule_claims_task_fkey FOREIGN KEY (tenant_id, task_id)
    REFERENCES sp_planner_tasks(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sp_planner_schedule_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_schedule_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_schedule_claims_tenant ON sp_planner_schedule_claims
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER sp_planner_schedule_claims_immutable BEFORE UPDATE OR DELETE ON sp_planner_schedule_claims
  FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();
REVOKE ALL PRIVILEGES ON sp_planner_schedule_claims FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON sp_planner_schedule_claims FROM capiro_app;
    GRANT SELECT, INSERT ON sp_planner_schedule_claims TO capiro_app;
  END IF;
END;
$$;
