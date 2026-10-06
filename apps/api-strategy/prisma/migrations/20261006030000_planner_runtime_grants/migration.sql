-- The production Strategies serve task uses the existing capiro_app credential;
-- migrations use the DDL credential. Keep the runtime role on these tables only.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE ON
      sp_planner_projects, sp_planner_tasks, sp_planner_inbox,
      sp_planner_resources, sp_planner_attachments TO capiro_app;
    GRANT SELECT, INSERT ON sp_planner_events TO capiro_app;
  END IF;
END;
$$;
