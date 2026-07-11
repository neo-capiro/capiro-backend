-- Outreach usage telemetry (plan W2.5 / W3.3): prompt-spec traceability +
-- prompt-cache token counters on ai_usage_events. Additive + backfilled with
-- safe defaults, so this deploys with zero drift and no downtime.
ALTER TABLE "ai_usage_events"
  ADD COLUMN IF NOT EXISTS "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "cache_creation_tokens" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "prompt_spec_version" VARCHAR(8);
