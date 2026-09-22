-- Register Florida calendar/archive ingestion in the Phase 9 runtime registry.
--
-- This migration must follow every existing runtime-type migration. It expands
-- the current CHECK constraint and inserts the two jobs in one transaction.
-- Rows ship dark; the guarded activation script owns schedule state.

BEGIN;

ALTER TABLE "legiwatch_runtime_heartbeat"
  DROP CONSTRAINT IF EXISTS "legiwatch_runtime_heartbeat_type_check";

ALTER TABLE "legiwatch_runtime_heartbeat"
  ADD CONSTRAINT "legiwatch_runtime_heartbeat_type_check" CHECK (
    job_type IN (
      'central_discovery',
      'committee_enrichment',
      'committee_updates',
      'source_probe',
      'coverage_audit',
      'stream_preflight',
      'capture_worker',
      'archive_reconciliation',
      'intelligence_worker',
      'relevance_worker',
      'parallel_comparison',
      'metrics',
      'hearing_media_worker',
      'hearing_delivery_worker',
      'notification_drain',
      'florida_calendar',
      'florida_archive'
    )
  );

INSERT INTO "legiwatch_runtime_heartbeat" (
  "job_key", "job_type", "status", "enabled", "schedule_enabled",
  "expected_interval_seconds", "max_lag_seconds", "metrics"
)
VALUES
  ('florida-calendar', 'florida_calendar', 'disabled', false, false,  600, 1800, '{}'::jsonb),
  ('florida-archive',  'florida_archive',  'disabled', false, false, 1800, 5400, '{}'::jsonb)
ON CONFLICT ("job_key") DO UPDATE SET
  "job_type" = EXCLUDED."job_type",
  "expected_interval_seconds" = EXCLUDED."expected_interval_seconds",
  "max_lag_seconds" = EXCLUDED."max_lag_seconds",
  "updated_at" = now();

COMMIT;
