-- Rates and limits stay in dedicated internal resources, outside public project JSON.
CREATE UNIQUE INDEX sp_planner_project_budget_key ON sp_planner_resources(tenant_id,project_id)
  WHERE kind = 'project_budget';
CREATE UNIQUE INDEX sp_planner_project_budget_alert_key ON sp_planner_resources(tenant_id,project_id,owner_id)
  WHERE kind = 'project_budget_alert';
ALTER TABLE sp_planner_resources ADD CONSTRAINT sp_planner_budget_project_required
  CHECK (kind NOT IN ('project_budget','project_budget_alert') OR project_id IS NOT NULL);
CREATE TABLE sp_planner_budget_alert_claims (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sp_planner_budget_alert_claims_delivery_key UNIQUE(tenant_id,resource_id,owner_id,fingerprint),
  CONSTRAINT sp_planner_budget_alert_claims_resource_fkey FOREIGN KEY(tenant_id,resource_id)
    REFERENCES sp_planner_resources(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT sp_planner_budget_alert_claims_event_fkey FOREIGN KEY(tenant_id,resource_id,event_id)
    REFERENCES sp_planner_events(tenant_id,resource_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sp_planner_budget_alert_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_budget_alert_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_budget_alert_claims_tenant ON sp_planner_budget_alert_claims
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER sp_planner_budget_alert_claims_immutable BEFORE UPDATE OR DELETE ON sp_planner_budget_alert_claims
  FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();
REVOKE ALL PRIVILEGES ON sp_planner_budget_alert_claims FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON sp_planner_budget_alert_claims FROM capiro_app;
    GRANT SELECT,INSERT ON sp_planner_budget_alert_claims TO capiro_app;
  END IF;
END; $$;
