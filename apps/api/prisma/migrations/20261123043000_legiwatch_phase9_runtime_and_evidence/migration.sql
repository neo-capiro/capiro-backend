-- LegiWatch Phase 9 — runtime registry and verification evidence.
--
-- Runtime jobs are registered DARK. This migration creates no EventBridge rule,
-- task definition, or production activation. Separate out-of-band activation
-- must first pass the guarded readiness workflow.

INSERT INTO "legiwatch_runtime_heartbeat" (
  "job_key", "job_type", "status", "enabled", "schedule_enabled",
  "expected_interval_seconds", "max_lag_seconds", "metrics"
)
VALUES
  ('central-discovery',       'central_discovery',      'disabled', false, false,   900,  2700, '{}'::jsonb),
  ('committee-enrichment',    'committee_enrichment',   'disabled', false, false,  1800,  5400, '{}'::jsonb),
  ('committee-updates',       'committee_updates',      'disabled', false, false,  3600, 10800, '{}'::jsonb),
  ('source-probe',            'source_probe',           'disabled', false, false,  1800,  5400, '{}'::jsonb),
  ('coverage-audit',          'coverage_audit',         'disabled', false, false, 21600, 64800, '{}'::jsonb),
  ('stream-preflight',        'stream_preflight',       'disabled', false, false,   120,   600, '{}'::jsonb),
  ('capture-worker',          'capture_worker',         'disabled', false, false,    60,   300, '{}'::jsonb),
  ('archive-reconciliation',  'archive_reconciliation', 'disabled', false, false,  3600, 10800, '{}'::jsonb),
  ('intelligence-worker',     'intelligence_worker',    'disabled', false, false,    60,   300, '{}'::jsonb),
  ('parallel-comparison',     'parallel_comparison',    'disabled', false, false, 21600, 64800, '{}'::jsonb),
  ('metrics',                 'metrics',                'disabled', false, false,   300,  1200, '{}'::jsonb)
ON CONFLICT ("job_key") DO UPDATE SET
  "job_type" = EXCLUDED."job_type",
  "expected_interval_seconds" = EXCLUDED."expected_interval_seconds",
  "max_lag_seconds" = EXCLUDED."max_lag_seconds",
  "updated_at" = now();

CREATE TABLE IF NOT EXISTS "legiwatch_verification_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "evidence_type" TEXT NOT NULL,
  "evidence_source" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "hearing_id" TEXT,
  "capture_id" TEXT,
  "run_id" UUID,
  "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "expires_at" TIMESTAMPTZ(6),
  "artifact_uri" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "recorded_by" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "legiwatch_verification_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "legiwatch_verification_evidence_run_fk"
    FOREIGN KEY ("run_id") REFERENCES "legiwatch_cutover_run"("id") ON DELETE SET NULL,
  CONSTRAINT "legiwatch_verification_evidence_type_check" CHECK (
    evidence_type IN (
      'LIVE_DISCOVERY', 'LIVE_RESOLUTION', 'LIVE_CAPTURE', 'LIVE_DEEPGRAM',
      'RECOVERY_GAP', 'WORKER_CRASH_RECOVERY', 'NETWORK_RECOVERY',
      'DEEPGRAM_RECOVERY', 'DUPLICATE_SUPPRESSION', 'CONCURRENT_CAPTURES',
      'DELAYED_START', 'CANCELLATION', 'RESCHEDULE', 'SOURCE_ROTATION',
      'COMMITTEE_SITE_CHANGE', 'BROWSER_FALLBACK', 'POLICY_BLOCK',
      'SILENCE_HANDLING', 'SPEAKER_ATTRIBUTION', 'TENANT_RLS',
      'INTELLIGENCE_LATENCY', 'ROLLBACK'
    )
  ),
  CONSTRAINT "legiwatch_verification_evidence_source_check" CHECK (
    evidence_source IN ('LIVE', 'OFFICIAL_ARCHIVE', 'LOCAL_FIXTURE', 'MIXED')
  ),
  CONSTRAINT "legiwatch_verification_evidence_status_check" CHECK (
    status IN ('PASS', 'FAIL', 'BLOCKED')
  ),
  CONSTRAINT "legiwatch_verification_evidence_expiry_check" CHECK (
    expires_at IS NULL OR expires_at > observed_at
  ),
  CONSTRAINT "legiwatch_verification_evidence_details_check" CHECK (
    jsonb_typeof(details) = 'object'
  )
);

CREATE INDEX IF NOT EXISTS "legiwatch_verification_evidence_type_idx"
  ON "legiwatch_verification_evidence" (
    "evidence_type", "status", "observed_at" DESC
  );
CREATE INDEX IF NOT EXISTS "legiwatch_verification_evidence_hearing_idx"
  ON "legiwatch_verification_evidence" ("hearing_id", "observed_at" DESC);
CREATE INDEX IF NOT EXISTS "legiwatch_verification_evidence_expiry_idx"
  ON "legiwatch_verification_evidence" ("expires_at")
  WHERE "expires_at" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT ON "legiwatch_verification_evidence" TO capiro_app;
  END IF;
END
$$;

COMMENT ON TABLE "legiwatch_verification_evidence" IS
  'Immutable Phase 9 real-world/chaos proof. Cutover requires non-expired PASS evidence; tests alone do not satisfy live gates.';
