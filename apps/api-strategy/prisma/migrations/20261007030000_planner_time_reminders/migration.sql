-- Append-only submission reminder receipts, atomic with the event and Inbox rows.
CREATE TABLE sp_planner_time_reminder_claims (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  week_on DATE NOT NULL,
  scheduled_on DATE NOT NULL,
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sp_planner_time_reminder_claims_week CHECK (EXTRACT(ISODOW FROM week_on) = 1),
  CONSTRAINT sp_planner_time_reminder_claims_delivery_key UNIQUE (tenant_id,owner_id,week_on),
  CONSTRAINT sp_planner_time_reminder_claims_resource_key UNIQUE (tenant_id,resource_id),
  CONSTRAINT sp_planner_time_reminder_claims_resource_fkey FOREIGN KEY (tenant_id,resource_id)
    REFERENCES sp_planner_resources(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT sp_planner_time_reminder_claims_event_fkey FOREIGN KEY (tenant_id,resource_id,event_id)
    REFERENCES sp_planner_events(tenant_id,resource_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sp_planner_time_reminder_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_time_reminder_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_time_reminder_claims_tenant ON sp_planner_time_reminder_claims
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER sp_planner_time_reminder_claims_immutable BEFORE UPDATE OR DELETE ON sp_planner_time_reminder_claims
  FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();
REVOKE ALL PRIVILEGES ON sp_planner_time_reminder_claims FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON sp_planner_time_reminder_claims FROM capiro_app;
    GRANT SELECT,INSERT ON sp_planner_time_reminder_claims TO capiro_app;
  END IF;
END;
$$;
