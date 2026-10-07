-- Preserve original activity and every correction. Removal is recoverable.
CREATE TABLE sp_planner_event_revisions (
  id UUID NOT NULL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  event_id UUID NOT NULL,
  actor_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  text TEXT NOT NULL CHECK (length(text) <= 20000),
  minutes INTEGER CHECK (minutes BETWEEN 1 AND 1440),
  removed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sp_planner_event_revisions_tenant_id_event_id_version_key UNIQUE (tenant_id, event_id, version),
  CONSTRAINT sp_planner_event_revisions_tenant_id_event_id_fkey FOREIGN KEY (tenant_id, event_id)
    REFERENCES sp_planner_events(tenant_id, id) ON DELETE RESTRICT ON UPDATE CASCADE
);
ALTER TABLE sp_planner_event_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_event_revisions FORCE ROW LEVEL SECURITY;
CREATE POLICY sp_planner_event_revisions_tenant ON sp_planner_event_revisions
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE TRIGGER sp_planner_event_revisions_immutable BEFORE UPDATE OR DELETE ON sp_planner_event_revisions
  FOR EACH ROW EXECUTE FUNCTION sp_planner_events_immutable();
REVOKE ALL PRIVILEGES ON sp_planner_event_revisions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON sp_planner_event_revisions FROM capiro_app;
    GRANT SELECT, INSERT ON sp_planner_event_revisions TO capiro_app;
  END IF;
END;
$$;
-- Forward-only: retain original events and revisions through image recovery.
