-- Additive goal activity/history on the existing immutable activity stream.
ALTER TABLE sp_planner_events ADD COLUMN resource_id UUID,
  ADD COLUMN details JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE sp_planner_events ADD CONSTRAINT sp_planner_events_resource_fkey
  FOREIGN KEY (tenant_id,resource_id) REFERENCES sp_planner_resources(tenant_id,id)
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE sp_planner_events ADD CONSTRAINT sp_planner_events_resource_target
  CHECK (resource_id IS NULL OR (task_id IS NULL AND project_id IS NULL));
ALTER TABLE sp_planner_events ADD CONSTRAINT sp_planner_events_details_object
  CHECK (jsonb_typeof(details) = 'object');
CREATE INDEX sp_planner_events_tenant_id_resource_id_created_at_idx
  ON sp_planner_events(tenant_id,resource_id,created_at);

ALTER TABLE sp_planner_events ADD CONSTRAINT sp_planner_events_tenant_id_resource_id_id_key UNIQUE (tenant_id,resource_id,id);

CREATE TABLE sp_planner_goal_reminder_claims (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  resource_id UUID NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('update','grading')),
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  deadline_key CHAR(64) NOT NULL CHECK (deadline_key ~ '^[0-9a-f]{64}$'),
  event_id UUID NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sp_planner_goal_reminder_claims_delivery_key UNIQUE
    (tenant_id,resource_id,owner_id,kind,fingerprint,deadline_key),
  CONSTRAINT sp_planner_goal_reminder_claims_resource_fkey FOREIGN KEY (tenant_id,resource_id)
    REFERENCES sp_planner_resources(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT sp_planner_goal_reminder_claims_event_fkey FOREIGN KEY (tenant_id,resource_id,event_id)
    REFERENCES sp_planner_events(tenant_id,resource_id,id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sp_planner_goal_reminder_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_goal_reminder_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_goal_reminder_claims_tenant ON sp_planner_goal_reminder_claims
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER sp_planner_goal_reminder_claims_immutable BEFORE UPDATE OR DELETE ON sp_planner_goal_reminder_claims
  FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();
REVOKE ALL PRIVILEGES ON sp_planner_goal_reminder_claims FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON sp_planner_goal_reminder_claims FROM capiro_app;
    GRANT SELECT,INSERT ON sp_planner_goal_reminder_claims TO capiro_app;
  END IF;
END;
$$;
