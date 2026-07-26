ALTER TABLE "intel_alert_digest_queue"
  ADD COLUMN "attempts"     INTEGER      NOT NULL DEFAULT 0,
  ADD COLUMN "last_error"   TEXT,
  ADD COLUMN "delivered_at" TIMESTAMPTZ(6);
