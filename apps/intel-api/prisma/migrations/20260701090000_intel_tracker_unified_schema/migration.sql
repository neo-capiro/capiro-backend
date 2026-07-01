-- AlterTable
ALTER TABLE "intel_watchlist" ADD COLUMN     "issue_areas" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "intel_watchlist_term" ADD COLUMN     "topic_id" TEXT;

-- CreateTable
CREATE TABLE "intel_watchlist_topic" (
    "id" TEXT NOT NULL,
    "watchlist_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "issue_area" TEXT,
    "position" TEXT NOT NULL DEFAULT 'monitor',
    "priority" TEXT NOT NULL DEFAULT 'med',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_watchlist_topic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_tracked_bill" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "bill_id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'congress',
    "note" TEXT,
    "is_manual" BOOLEAN NOT NULL DEFAULT false,
    "tracked_by" TEXT,
    "tracked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stage" TEXT,
    "last_seen_action_text" TEXT,
    "last_seen_action_date" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3),
    "unread" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_tracked_bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_alert" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_ref" TEXT NOT NULL,
    "watchlist_id" TEXT,
    "topic_id" TEXT,
    "term_id" TEXT,
    "kind" TEXT NOT NULL,
    "change_type" TEXT,
    "severity" TEXT NOT NULL,
    "materiality" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "client_impact" TEXT,
    "urgency" TEXT,
    "title" TEXT NOT NULL,
    "why_it_matters" TEXT,
    "recommended_action" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'new',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMP(3),

    CONSTRAINT "intel_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_alert_preference" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "triggers" TEXT[] DEFAULT ARRAY[]::TEXT[],
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
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_alert_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_notification_log" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_alert_digest_queue" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "alert_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cadence" TEXT NOT NULL,
    "flushed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_alert_digest_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_feedback" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "alert_id" TEXT,
    "target_type" TEXT NOT NULL,
    "target_ref" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_watchlist_topic_watchlist_id_idx" ON "intel_watchlist_topic"("watchlist_id");

-- CreateIndex
CREATE INDEX "intel_watchlist_topic_tenant_id_watchlist_id_idx" ON "intel_watchlist_topic"("tenant_id", "watchlist_id");

-- CreateIndex
CREATE INDEX "intel_tracked_bill_tenant_id_client_id_idx" ON "intel_tracked_bill"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "intel_tracked_bill_bill_id_idx" ON "intel_tracked_bill"("bill_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_tracked_bill_client_id_bill_id_key" ON "intel_tracked_bill"("client_id", "bill_id");

-- CreateIndex
CREATE INDEX "intel_alert_tenant_id_client_id_created_at_idx" ON "intel_alert"("tenant_id", "client_id", "created_at");

-- CreateIndex
CREATE INDEX "intel_alert_tenant_id_status_idx" ON "intel_alert"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "intel_alert_tenant_id_source_type_source_ref_idx" ON "intel_alert"("tenant_id", "source_type", "source_ref");

-- CreateIndex
CREATE INDEX "intel_alert_preference_tenant_id_client_id_idx" ON "intel_alert_preference"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_alert_preference_user_id_client_id_key" ON "intel_alert_preference"("user_id", "client_id");

-- CreateIndex
CREATE INDEX "intel_notification_log_tenant_id_client_id_idx" ON "intel_notification_log"("tenant_id", "client_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_notification_log_alert_id_user_id_channel_key" ON "intel_notification_log"("alert_id", "user_id", "channel");

-- CreateIndex
CREATE INDEX "intel_alert_digest_queue_tenant_id_user_id_channel_flushed_idx" ON "intel_alert_digest_queue"("tenant_id", "user_id", "channel", "flushed");

-- CreateIndex
CREATE INDEX "intel_feedback_tenant_id_client_id_idx" ON "intel_feedback"("tenant_id", "client_id");

-- CreateIndex
CREATE INDEX "intel_feedback_target_ref_idx" ON "intel_feedback"("target_ref");

-- CreateIndex
CREATE INDEX "intel_watchlist_term_topic_id_idx" ON "intel_watchlist_term"("topic_id");

-- AddForeignKey
ALTER TABLE "intel_watchlist_term" ADD CONSTRAINT "intel_watchlist_term_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "intel_watchlist_topic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intel_watchlist_topic" ADD CONSTRAINT "intel_watchlist_topic_watchlist_id_fkey" FOREIGN KEY ("watchlist_id") REFERENCES "intel_watchlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

