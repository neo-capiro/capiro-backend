-- Client-profile "Tracker" tab. Extracts bill tracking out of the Intelligence
-- tab into a curated Board (tracked_bill is the membership table) + a
-- Recommendations feed + per-client Configure (watchlist + alert prefs), with an
-- email/SMS alert delivery pipeline. All new tables are TENANT-scoped with RLS,
-- mirroring the tracked_bill / alert_state isolation convention (tenant_id
-- column + policy, no FK).

-- ── tracked_bill: board-membership provenance + change-detection snapshot ────
ALTER TABLE "tracked_bill" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "tracked_bill" ADD COLUMN IF NOT EXISTS "last_seen_action_text" TEXT;
ALTER TABLE "tracked_bill" ADD COLUMN IF NOT EXISTS "last_seen_action_date" DATE;
ALTER TABLE "tracked_bill" ADD COLUMN IF NOT EXISTS "last_seen_at" TIMESTAMPTZ(6);

-- ── client_watchlist: per-client targeting (issue areas + watchlist tags) ────
CREATE TABLE IF NOT EXISTS "client_watchlist" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "issue_areas" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "tags" JSONB NOT NULL DEFAULT '[]',
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "client_watchlist_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "client_watchlist_client_id_key"
    ON "client_watchlist" ("client_id");
CREATE INDEX IF NOT EXISTS "client_watchlist_tenant_id_idx" ON "client_watchlist" ("tenant_id");

ALTER TABLE "client_watchlist" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_watchlist" FORCE ROW LEVEL SECURITY;
CREATE POLICY "client_watchlist_isolation" ON "client_watchlist"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── alert_preference: per-user-per-client channels/triggers/materiality ──────
CREATE TABLE IF NOT EXISTS "alert_preference" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "triggers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "materiality" TEXT NOT NULL DEFAULT 'medium',
    "email_enabled" BOOLEAN NOT NULL DEFAULT false,
    "email_address" TEXT,
    "email_cadence" TEXT NOT NULL DEFAULT 'realtime',
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sms_phone" TEXT,
    "sms_phone_verified" BOOLEAN NOT NULL DEFAULT false,
    "sms_cadence" TEXT NOT NULL DEFAULT 'realtime',
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_preference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "alert_preference_user_id_client_id_key"
    ON "alert_preference" ("user_id", "client_id");
CREATE INDEX IF NOT EXISTS "alert_preference_tenant_id_idx" ON "alert_preference" ("tenant_id");
CREATE INDEX IF NOT EXISTS "alert_preference_client_id_idx" ON "alert_preference" ("client_id");

ALTER TABLE "alert_preference" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_preference" FORCE ROW LEVEL SECURITY;
CREATE POLICY "alert_preference_isolation" ON "alert_preference"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── tracker_feedback: recommendation training signal ─────────────────────────
CREATE TABLE IF NOT EXISTS "tracker_feedback" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT,
    "bill_id" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "tracker_feedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "tracker_feedback_tenant_id_idx" ON "tracker_feedback" ("tenant_id");
CREATE INDEX IF NOT EXISTS "tracker_feedback_client_id_idx" ON "tracker_feedback" ("client_id");
CREATE INDEX IF NOT EXISTS "tracker_feedback_bill_id_idx" ON "tracker_feedback" ("bill_id");

ALTER TABLE "tracker_feedback" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tracker_feedback" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tracker_feedback_isolation" ON "tracker_feedback"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── notification_log: idempotent fan-out ledger + deliverability audit ───────
CREATE TABLE IF NOT EXISTS "notification_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "notification_log_alert_id_user_id_channel_key"
    ON "notification_log" ("alert_id", "user_id", "channel");
CREATE INDEX IF NOT EXISTS "notification_log_tenant_id_idx" ON "notification_log" ("tenant_id");
CREATE INDEX IF NOT EXISTS "notification_log_client_id_idx" ON "notification_log" ("client_id");

ALTER TABLE "notification_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notification_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY "notification_log_isolation" ON "notification_log"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── alert_digest_queue: buffer for daily/weekly digest flush ─────────────────
CREATE TABLE IF NOT EXISTS "alert_digest_queue" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "flushed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "alert_digest_queue_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "alert_digest_queue_tenant_id_idx" ON "alert_digest_queue" ("tenant_id");
CREATE INDEX IF NOT EXISTS "alert_digest_queue_drain_idx"
    ON "alert_digest_queue" ("user_id", "channel", "cadence", "flushed");

ALTER TABLE "alert_digest_queue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "alert_digest_queue" FORCE ROW LEVEL SECURITY;
CREATE POLICY "alert_digest_queue_isolation" ON "alert_digest_queue"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── sms_verification: hashed OTP / opt-in consent record ─────────────────────
CREATE TABLE IF NOT EXISTS "sms_verification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "client_id" UUID,
    "phone" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "sms_verification_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sms_verification_user_id_idx" ON "sms_verification" ("user_id");
CREATE INDEX IF NOT EXISTS "sms_verification_tenant_id_idx" ON "sms_verification" ("tenant_id");

ALTER TABLE "sms_verification" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sms_verification" FORCE ROW LEVEL SECURITY;
CREATE POLICY "sms_verification_isolation" ON "sms_verification"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- Grant the runtime role access to the new tables (RLS still applies on top).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      "client_watchlist", "alert_preference", "tracker_feedback",
      "notification_log", "alert_digest_queue", "sms_verification"
      TO capiro_app;
  END IF;
END
$$;
