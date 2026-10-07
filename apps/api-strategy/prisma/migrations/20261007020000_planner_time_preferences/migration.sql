-- Personal timesheet preferences use the existing tenant-scoped resource table.
CREATE UNIQUE INDEX sp_planner_time_preferences_owner
  ON sp_planner_resources(tenant_id, owner_id) WHERE kind = 'time_preferences';
-- No role, grant, authentication or row-security changes.
-- Forward-only: preserve existing weekly sheets and immutable time history.
