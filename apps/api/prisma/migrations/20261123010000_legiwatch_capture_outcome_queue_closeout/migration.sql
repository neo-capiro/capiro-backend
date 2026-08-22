-- LegiWatch Live Hearings — Phase 0/5/6 closeout.
--
-- ADDITIVE, FORWARD-ONLY.
--
-- 1. Preserve the exact domain capture state across worker restarts. The legacy
--    `status` column remains for compatibility with existing API readers, but it
--    intentionally collapses READY/PREPARING and COMPLETE/COMPLETE_WITH_GAPS.
--    `domain_status` is the authoritative state-machine value.
-- 2. Persist every resolver decision's reason/policy/provider/reference without
--    ever storing a short-lived media URL.
-- 3. Replace process-local enqueue semantics with a global durable job table.
--    Jobs carry stable public ids only: no tenant id, client id, watchlist terms,
--    media URL, Deepgram credential, or provider secret.

ALTER TABLE "public_hearing_capture"
  ADD COLUMN IF NOT EXISTS "domain_status" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution_reason_code" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution_capture_policy" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution_provider" TEXT,
  ADD COLUMN IF NOT EXISTS "resolution_reference" TEXT,
  ADD COLUMN IF NOT EXISTS "terminal_reason_code" TEXT,
  ADD COLUMN IF NOT EXISTS "last_outcome_at" TIMESTAMPTZ(6);

UPDATE "public_hearing_capture"
SET "domain_status" = CASE "status"
  WHEN 'scheduled' THEN 'SCHEDULED'
  WHEN 'leased' THEN 'READY'
  WHEN 'capturing' THEN 'CAPTURING'
  WHEN 'ended' THEN 'COMPLETE'
  WHEN 'failed' THEN 'FAILED'
  WHEN 'no_stream' THEN 'BLOCKED'
  ELSE 'PREPARING'
END
WHERE "domain_status" IS NULL;

ALTER TABLE "public_hearing_capture"
  ALTER COLUMN "domain_status" SET DEFAULT 'SCHEDULED',
  ALTER COLUMN "domain_status" SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'public_hearing_capture_domain_status_chk'
  ) THEN
    ALTER TABLE "public_hearing_capture"
      ADD CONSTRAINT "public_hearing_capture_domain_status_chk"
      CHECK ("domain_status" IN (
        'SCHEDULED', 'PREPARING', 'WAITING_FOR_STREAM', 'READY',
        'CAPTURING', 'RECOVERING', 'FINALIZING', 'COMPLETE',
        'COMPLETE_WITH_GAPS', 'FAILED', 'CANCELED', 'BLOCKED'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'public_hearing_capture_resolution_policy_chk'
  ) THEN
    ALTER TABLE "public_hearing_capture"
      ADD CONSTRAINT "public_hearing_capture_resolution_policy_chk"
      CHECK (
        "resolution_capture_policy" IS NULL OR
        "resolution_capture_policy" IN (
          'SERVER_CAPTURE_ALLOWED', 'BROWSER_CAPTURE_ONLY', 'LICENSE_REQUIRED',
          'BLOCKED', 'REVIEW_REQUIRED'
        )
      );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "public_hearing_capture_domain_status_idx"
  ON "public_hearing_capture" ("domain_status");
CREATE INDEX IF NOT EXISTS "public_hearing_capture_resolution_reason_idx"
  ON "public_hearing_capture" ("resolution_reason_code");

CREATE TABLE IF NOT EXISTS "public_hearing_capture_job" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "job_type" TEXT NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "hearing_id" TEXT NOT NULL,
  "capture_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "due_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL DEFAULT 10,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "completed_at" TIMESTAMPTZ(6),

  CONSTRAINT "public_hearing_capture_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "public_hearing_capture_job_dedupe_key_key" UNIQUE ("dedupe_key"),
  CONSTRAINT "public_hearing_capture_job_capture_id_fkey"
    FOREIGN KEY ("capture_id") REFERENCES "public_hearing_capture"("id") ON DELETE CASCADE,
  CONSTRAINT "public_hearing_capture_job_type_chk"
    CHECK ("job_type" IN ('preflight', 'capture')),
  CONSTRAINT "public_hearing_capture_job_status_chk"
    CHECK ("status" IN ('pending', 'leased', 'completed', 'failed')),
  CONSTRAINT "public_hearing_capture_job_attempts_chk"
    CHECK ("attempts" >= 0 AND "max_attempts" > 0),
  CONSTRAINT "public_hearing_capture_job_capture_shape_chk"
    CHECK (
      ("job_type" = 'preflight' AND "capture_id" IS NULL) OR
      ("job_type" = 'capture' AND "capture_id" IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS "public_hearing_capture_job_due_idx"
  ON "public_hearing_capture_job" ("job_type", "status", "due_at");
CREATE INDEX IF NOT EXISTS "public_hearing_capture_job_lease_idx"
  ON "public_hearing_capture_job" ("status", "lease_expires_at");
CREATE INDEX IF NOT EXISTS "public_hearing_capture_job_hearing_idx"
  ON "public_hearing_capture_job" ("hearing_id", "job_type");

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "public_hearing_capture_job" TO capiro_app;
  END IF;
END
$$;
