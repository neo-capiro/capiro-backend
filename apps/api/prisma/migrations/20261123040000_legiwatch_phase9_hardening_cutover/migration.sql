-- LegiWatch Live Hearings — Phase 9 production hardening and guarded cutover.
--
-- ADDITIVE, FORWARD-ONLY, DARK BY DEFAULT.
--
-- This migration does not enable a scheduler, tenant flag, capture-all posture,
-- or production-default UI. It creates the durable evidence/control plane used
-- to prove readiness before an operator performs any of those separate actions.
--
-- The data in these tables is global operational metadata. It contains no
-- tenant/client/watchlist context and therefore intentionally has no tenant_id.

CREATE TABLE IF NOT EXISTS "legiwatch_runtime_heartbeat" (
  "job_key" TEXT NOT NULL,
  "job_type" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'disabled',
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "schedule_enabled" BOOLEAN NOT NULL DEFAULT false,
  "expected_interval_seconds" INTEGER,
  "max_lag_seconds" INTEGER,
  "rule_name" TEXT,
  "task_family" TEXT,
  "last_started_at" TIMESTAMPTZ(6),
  "last_heartbeat_at" TIMESTAMPTZ(6),
  "last_success_at" TIMESTAMPTZ(6),
  "last_failure_at" TIMESTAMPTZ(6),
  "last_finished_at" TIMESTAMPTZ(6),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "metrics" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_runtime_heartbeat_pkey" PRIMARY KEY ("job_key"),
  CONSTRAINT "legiwatch_runtime_heartbeat_type_check" CHECK (
    job_type IN (
      'central_discovery', 'committee_enrichment', 'committee_updates',
      'source_probe', 'coverage_audit', 'stream_preflight', 'capture_worker',
      'archive_reconciliation', 'intelligence_worker', 'relevance_worker',
      'parallel_comparison', 'metrics'
    )
  ),
  CONSTRAINT "legiwatch_runtime_heartbeat_status_check" CHECK (
    status IN ('disabled', 'idle', 'running', 'succeeded', 'failed', 'stale')
  ),
  CONSTRAINT "legiwatch_runtime_heartbeat_interval_check" CHECK (
    expected_interval_seconds IS NULL OR expected_interval_seconds > 0
  ),
  CONSTRAINT "legiwatch_runtime_heartbeat_lag_check" CHECK (
    max_lag_seconds IS NULL OR max_lag_seconds > 0
  ),
  CONSTRAINT "legiwatch_runtime_heartbeat_failure_check" CHECK (
    consecutive_failures >= 0
  ),
  CONSTRAINT "legiwatch_runtime_heartbeat_metrics_check" CHECK (
    jsonb_typeof(metrics) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS "legiwatch_runtime_heartbeat_status_idx"
  ON "legiwatch_runtime_heartbeat" ("status", "last_heartbeat_at");
CREATE INDEX IF NOT EXISTS "legiwatch_runtime_heartbeat_enabled_idx"
  ON "legiwatch_runtime_heartbeat" ("enabled", "schedule_enabled", "job_type");

CREATE TABLE IF NOT EXISTS "legiwatch_cutover_run" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "evidence_source" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(6) NOT NULL,
  "window_end" TIMESTAMPTZ(6) NOT NULL,
  "parent_bodies" INTEGER NOT NULL DEFAULT 0,
  "subcommittee_bodies" INTEGER NOT NULL DEFAULT 0,
  "total_bodies" INTEGER NOT NULL DEFAULT 0,
  "official_observations" INTEGER NOT NULL DEFAULT 0,
  "represented_observations" INTEGER NOT NULL DEFAULT 0,
  "explicit_conflicts" INTEGER NOT NULL DEFAULT 0,
  "eligible_events" INTEGER NOT NULL DEFAULT 0,
  "events_with_outcomes" INTEGER NOT NULL DEFAULT 0,
  "duplicate_canonical_events" INTEGER NOT NULL DEFAULT 0,
  "duplicate_global_captures" INTEGER NOT NULL DEFAULT 0,
  "unresolved_events" INTEGER NOT NULL DEFAULT 0,
  "stale_jobs" INTEGER NOT NULL DEFAULT 0,
  "lagging_intelligence_jobs" INTEGER NOT NULL DEFAULT 0,
  "blocker_count" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "blockers" TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
  "created_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_cutover_run_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_cutover_run_mode_check" CHECK (
    mode IN (
      'SHADOW', 'CANARY', 'READINESS', 'CUTOVER_VERIFICATION',
      'ROLLBACK_VERIFICATION'
    )
  ),
  CONSTRAINT "legiwatch_cutover_run_status_check" CHECK (
    status IN ('PASS', 'FAIL', 'BLOCKED')
  ),
  CONSTRAINT "legiwatch_cutover_run_evidence_check" CHECK (
    evidence_source IN ('LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED', 'NONE')
  ),
  CONSTRAINT "legiwatch_cutover_run_window_check" CHECK (window_end >= window_start),
  CONSTRAINT "legiwatch_cutover_run_nonnegative_check" CHECK (
    parent_bodies >= 0 AND
    subcommittee_bodies >= 0 AND
    total_bodies >= 0 AND
    official_observations >= 0 AND
    represented_observations >= 0 AND
    explicit_conflicts >= 0 AND
    eligible_events >= 0 AND
    events_with_outcomes >= 0 AND
    duplicate_canonical_events >= 0 AND
    duplicate_global_captures >= 0 AND
    unresolved_events >= 0 AND
    stale_jobs >= 0 AND
    lagging_intelligence_jobs >= 0 AND
    blocker_count >= 0
  ),
  CONSTRAINT "legiwatch_cutover_run_body_sum_check" CHECK (
    total_bodies = parent_bodies + subcommittee_bodies
  ),
  CONSTRAINT "legiwatch_cutover_run_no_zero_evidence_pass_check" CHECK (
    NOT (status = 'PASS' AND evidence_source = 'NONE')
  ),
  CONSTRAINT "legiwatch_cutover_run_summary_check" CHECK (
    jsonb_typeof(summary) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS "legiwatch_cutover_run_created_idx"
  ON "legiwatch_cutover_run" ("created_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_cutover_run_status_idx"
  ON "legiwatch_cutover_run" ("mode", "status", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "legiwatch_event_audit" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "run_id" UUID NOT NULL,
  "hearing_id" TEXT,
  "observation_id" TEXT,
  "committee_system_code" TEXT,
  "gate_key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_event_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_event_audit_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "legiwatch_cutover_run"("id") ON DELETE CASCADE,
  CONSTRAINT "legiwatch_event_audit_status_check" CHECK (
    status IN ('PASS', 'FAIL', 'CONFLICT', 'NOT_APPLICABLE')
  ),
  CONSTRAINT "legiwatch_event_audit_anchor_check" CHECK (
    hearing_id IS NOT NULL OR observation_id IS NOT NULL OR committee_system_code IS NOT NULL
  ),
  CONSTRAINT "legiwatch_event_audit_details_check" CHECK (
    jsonb_typeof(details) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS "legiwatch_event_audit_run_status_idx"
  ON "legiwatch_event_audit" ("run_id", "status", "gate_key");
CREATE INDEX IF NOT EXISTS "legiwatch_event_audit_hearing_idx"
  ON "legiwatch_event_audit" ("hearing_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_event_audit_committee_idx"
  ON "legiwatch_event_audit" ("committee_system_code", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "legiwatch_cutover_state" (
  "id" TEXT NOT NULL DEFAULT 'global',
  "phase" TEXT NOT NULL DEFAULT 'SHADOW',
  "production_default" BOOLEAN NOT NULL DEFAULT false,
  "schedules_enabled" BOOLEAN NOT NULL DEFAULT false,
  "kill_switch_engaged" BOOLEAN NOT NULL DEFAULT true,
  "capture_all_public_events" BOOLEAN NOT NULL DEFAULT false,
  "minimum_consecutive_passes" INTEGER NOT NULL DEFAULT 3,
  "minimum_shadow_hours" INTEGER NOT NULL DEFAULT 168,
  "consecutive_passes" INTEGER NOT NULL DEFAULT 0,
  "shadow_started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "canary_started_at" TIMESTAMPTZ(6),
  "cutover_at" TIMESTAMPTZ(6),
  "rollback_at" TIMESTAMPTZ(6),
  "last_run_id" UUID,
  "last_passing_run_id" UUID,
  "updated_by" TEXT NOT NULL DEFAULT 'migration',
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_cutover_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_cutover_state_singleton_check" CHECK (id = 'global'),
  CONSTRAINT "legiwatch_cutover_state_phase_check" CHECK (
    phase IN ('SHADOW', 'CANARY', 'READY', 'CUTOVER', 'ROLLBACK')
  ),
  CONSTRAINT "legiwatch_cutover_state_threshold_check" CHECK (
    minimum_consecutive_passes >= 3 AND
    minimum_shadow_hours >= 24 AND
    consecutive_passes >= 0
  ),
  CONSTRAINT "legiwatch_cutover_state_default_gate_check" CHECK (
    production_default = false OR phase = 'CUTOVER'
  ),
  CONSTRAINT "legiwatch_cutover_state_schedule_gate_check" CHECK (
    schedules_enabled = false OR phase IN ('CANARY', 'READY', 'CUTOVER')
  ),
  CONSTRAINT "legiwatch_cutover_state_kill_switch_gate_check" CHECK (
    kill_switch_engaged = true OR phase = 'CUTOVER'
  ),
  CONSTRAINT "legiwatch_cutover_state_capture_all_gate_check" CHECK (
    capture_all_public_events = false OR phase = 'CUTOVER'
  ),
  CONSTRAINT "legiwatch_cutover_state_last_run_fk"
    FOREIGN KEY ("last_run_id") REFERENCES "legiwatch_cutover_run"("id") ON DELETE SET NULL,
  CONSTRAINT "legiwatch_cutover_state_last_passing_run_fk"
    FOREIGN KEY ("last_passing_run_id") REFERENCES "legiwatch_cutover_run"("id") ON DELETE SET NULL
);

INSERT INTO "legiwatch_cutover_state" (
  "id", "phase", "production_default", "schedules_enabled",
  "kill_switch_engaged", "capture_all_public_events",
  "minimum_consecutive_passes", "minimum_shadow_hours",
  "consecutive_passes", "updated_by"
)
VALUES (
  'global', 'SHADOW', false, false, true, false, 3, 168, 0, 'migration'
)
ON CONFLICT ("id") DO NOTHING;

CREATE OR REPLACE FUNCTION enforce_legiwatch_cutover_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  IF OLD.id <> 'global' OR NEW.id <> 'global' THEN
    RAISE EXCEPTION 'LegiWatch cutover state is a singleton';
  END IF;

  IF NEW.phase <> OLD.phase AND NOT (
    (OLD.phase = 'SHADOW' AND NEW.phase IN ('CANARY', 'ROLLBACK')) OR
    (OLD.phase = 'CANARY' AND NEW.phase IN ('SHADOW', 'READY', 'ROLLBACK')) OR
    (OLD.phase = 'READY' AND NEW.phase IN ('CANARY', 'CUTOVER', 'ROLLBACK')) OR
    (OLD.phase = 'CUTOVER' AND NEW.phase IN ('ROLLBACK')) OR
    (OLD.phase = 'ROLLBACK' AND NEW.phase IN ('SHADOW'))
  ) THEN
    RAISE EXCEPTION 'Illegal LegiWatch cutover transition: % -> %', OLD.phase, NEW.phase;
  END IF;

  IF NEW.production_default AND NEW.phase <> 'CUTOVER' THEN
    RAISE EXCEPTION 'LegiWatch cannot become the production default before CUTOVER';
  END IF;
  IF NOT NEW.kill_switch_engaged AND NEW.phase <> 'CUTOVER' THEN
    RAISE EXCEPTION 'LegiWatch kill switch cannot be disengaged before CUTOVER';
  END IF;
  IF NEW.capture_all_public_events AND NEW.phase <> 'CUTOVER' THEN
    RAISE EXCEPTION 'Capture-all cannot be enabled before CUTOVER';
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "legiwatch_cutover_state_transition_guard"
  ON "legiwatch_cutover_state";
CREATE TRIGGER "legiwatch_cutover_state_transition_guard"
BEFORE UPDATE ON "legiwatch_cutover_state"
FOR EACH ROW
EXECUTE FUNCTION enforce_legiwatch_cutover_transition();

CREATE OR REPLACE FUNCTION prevent_legiwatch_cutover_state_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
BEGIN
  RAISE EXCEPTION 'LegiWatch cutover state cannot be deleted';
END
$$;

DROP TRIGGER IF EXISTS "legiwatch_cutover_state_delete_guard"
  ON "legiwatch_cutover_state";
CREATE TRIGGER "legiwatch_cutover_state_delete_guard"
BEFORE DELETE ON "legiwatch_cutover_state"
FOR EACH ROW
EXECUTE FUNCTION prevent_legiwatch_cutover_state_delete();

REVOKE ALL ON FUNCTION enforce_legiwatch_cutover_transition() FROM PUBLIC;
REVOKE ALL ON FUNCTION prevent_legiwatch_cutover_state_delete() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "legiwatch_runtime_heartbeat" TO capiro_app;
    GRANT SELECT, INSERT ON "legiwatch_cutover_run" TO capiro_app;
    GRANT SELECT, INSERT ON "legiwatch_event_audit" TO capiro_app;
    GRANT SELECT, UPDATE ON "legiwatch_cutover_state" TO capiro_app;
    GRANT EXECUTE ON FUNCTION enforce_legiwatch_cutover_transition() TO capiro_app;
    GRANT EXECUTE ON FUNCTION prevent_legiwatch_cutover_state_delete() TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "legiwatch_runtime_heartbeat" IS
  'Global Phase 9 job freshness and queue/worker health; schedules remain disabled until separately activated.';
COMMENT ON TABLE "legiwatch_cutover_run" IS
  'Immutable Phase 9 readiness evidence. A zero-event or NONE-evidence run cannot pass.';
COMMENT ON TABLE "legiwatch_event_audit" IS
  'Per-body/per-event launch-gate evidence attached to an immutable cutover run.';
COMMENT ON TABLE "legiwatch_cutover_state" IS
  'Guarded singleton cutover state. Seeded SHADOW with schedules/default/capture-all off and kill switch engaged.';