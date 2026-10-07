-- Aurora's existing default privileges grant ALL to the application role on
-- new tables. Restrict only Planner's tables after creation; do not change
-- shared role attributes, default privileges, or another module's grants.
ALTER TABLE sp_planner_projects FORCE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_inbox FORCE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_resources FORCE ROW LEVEL SECURITY;
ALTER TABLE sp_planner_attachments FORCE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON
  sp_planner_projects, sp_planner_tasks, sp_planner_events,
  sp_planner_inbox, sp_planner_resources, sp_planner_attachments FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    REVOKE ALL PRIVILEGES ON
      sp_planner_projects, sp_planner_tasks, sp_planner_events,
      sp_planner_inbox, sp_planner_resources, sp_planner_attachments FROM capiro_app;
    GRANT SELECT, INSERT, UPDATE ON
      sp_planner_projects, sp_planner_tasks, sp_planner_inbox,
      sp_planner_resources, sp_planner_attachments TO capiro_app;
    GRANT SELECT, INSERT ON sp_planner_events TO capiro_app;
  END IF;
END;
$$;

-- Forward-only. Image rollback retains these protections and Planner data.
