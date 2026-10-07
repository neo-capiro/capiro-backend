-- Time corrections retain complete date, project and billable snapshots.
-- Existing corrections retain their original metadata through the empty default.
ALTER TABLE sp_planner_event_revisions ADD COLUMN details JSONB NOT NULL DEFAULT '{}';
CREATE INDEX sp_planner_events_time_actor ON sp_planner_events(tenant_id, actor_id, created_at)
  WHERE kind = 'time';
CREATE UNIQUE INDEX sp_planner_timesheet_week ON sp_planner_resources(tenant_id, owner_id, (data->>'weekOn'))
  WHERE kind = 'timesheet';
CREATE UNIQUE INDEX sp_planner_time_settings_tenant ON sp_planner_resources(tenant_id)
  WHERE kind = 'time_settings';
-- No grant or row-security changes; the existing append-only trigger covers details.
-- Forward-only: retain original time entries and immutable correction history.
