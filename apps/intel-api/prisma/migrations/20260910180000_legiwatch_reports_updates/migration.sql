-- AlterTable
ALTER TABLE "intel_notification_log" ADD COLUMN     "lease_token" TEXT,
ADD COLUMN     "lease_until" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "intel_legiwatch_report" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder_ids" TEXT[],
    "jurisdiction" TEXT NOT NULL,
    "session_key" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_report_run" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "definition_version" INTEGER NOT NULL,
    "created_by" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'external',
    "cutoff" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_legiwatch_report_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_promotion" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "staged_id" TEXT NOT NULL,
    "source_account" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_version" INTEGER NOT NULL,
    "source_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "reviewed_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_legiwatch_promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_report_contact" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "opted_out" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_report_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_report_list" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT true,
    "contact_ids" TEXT[],
    "version" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_report_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_report_subscription" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "report_id" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "report_version" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "local_minutes" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'draft',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "send_no_change" BOOLEAN NOT NULL DEFAULT false,
    "catch_up" TEXT NOT NULL DEFAULT 'draft',
    "recipients" JSONB NOT NULL DEFAULT '[]',
    "subject" TEXT NOT NULL,
    "introduction" TEXT NOT NULL DEFAULT '',
    "version" INTEGER NOT NULL DEFAULT 0,
    "baseline_at" TIMESTAMP(3),
    "checkpoint_at" TIMESTAMP(3),
    "next_due_at" TIMESTAMP(3),
    "activated_by" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_report_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_report_occurrence" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "subscription_version" INTEGER NOT NULL,
    "occurrence_key" TEXT NOT NULL,
    "intended_at" TIMESTAMP(3) NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "configuration" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',
    "run_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_legiwatch_report_occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_delivery" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'bill_report',
    "intent_key" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "run_id" TEXT,
    "subscription_id" TEXT,
    "subscription_version" INTEGER,
    "composition" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intel_legiwatch_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_delivery_recipient" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "destination_hash" TEXT NOT NULL,
    "recipient" JSONB NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "state" TEXT NOT NULL DEFAULT 'queued',
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "dispatch_started_at" TIMESTAMP(3),
    "provider_id" TEXT,
    "accepted_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "intel_legiwatch_delivery_recipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_record_rule" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "owner_clerk_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "folder_ids" TEXT[],
    "recipients" JSONB NOT NULL,
    "cadence" TEXT NOT NULL,
    "timezone" TEXT,
    "local_minutes" INTEGER,
    "state" TEXT NOT NULL DEFAULT 'needs_review',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,
    "activated_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_record_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_rule_bill_baseline" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "baseline_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intel_legiwatch_rule_bill_baseline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intel_legiwatch_record_match" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "rule_version" INTEGER NOT NULL,
    "event_key" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "folder_ids" TEXT[],
    "first_observed_at" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'queued',

    CONSTRAINT "intel_legiwatch_record_match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intel_legiwatch_report_tenant_id_archived_idx" ON "intel_legiwatch_report"("tenant_id", "archived");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_tenant_id_id_key" ON "intel_legiwatch_report"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_report_run_tenant_id_report_id_generated_at_idx" ON "intel_legiwatch_report_run"("tenant_id", "report_id", "generated_at");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_run_tenant_id_id_key" ON "intel_legiwatch_report_run"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_promotion_tenant_id_kind_target_id_idx" ON "intel_legiwatch_promotion"("tenant_id", "kind", "target_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_promotion_tenant_id_staged_id_key" ON "intel_legiwatch_promotion"("tenant_id", "staged_id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_report_contact_tenant_id_email_idx" ON "intel_legiwatch_report_contact"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_contact_tenant_id_id_key" ON "intel_legiwatch_report_contact"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_list_tenant_id_id_key" ON "intel_legiwatch_report_list"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_report_subscription_enabled_next_due_at_idx" ON "intel_legiwatch_report_subscription"("enabled", "next_due_at");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_subscription_tenant_id_id_key" ON "intel_legiwatch_report_subscription"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_report_occurrence_state_intended_at_idx" ON "intel_legiwatch_report_occurrence"("state", "intended_at");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_occurrence_tenant_id_subscription_id_key" ON "intel_legiwatch_report_occurrence"("tenant_id", "subscription_id", "occurrence_key");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_report_occurrence_tenant_id_id_key" ON "intel_legiwatch_report_occurrence"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_delivery_tenant_id_intent_key_key" ON "intel_legiwatch_delivery"("tenant_id", "intent_key");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_delivery_tenant_id_id_key" ON "intel_legiwatch_delivery"("tenant_id", "id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_delivery_recipient_state_next_attempt_at_idx" ON "intel_legiwatch_delivery_recipient"("state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_delivery_recipient_tenant_id_delivery_id_de_key" ON "intel_legiwatch_delivery_recipient"("tenant_id", "delivery_id", "destination_hash", "channel");

-- CreateIndex
CREATE INDEX "intel_legiwatch_record_rule_state_tenant_id_idx" ON "intel_legiwatch_record_rule"("state", "tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_record_rule_tenant_id_id_key" ON "intel_legiwatch_record_rule"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_rule_bill_baseline_tenant_id_rule_id_assign_key" ON "intel_legiwatch_rule_bill_baseline"("tenant_id", "rule_id", "assignment_id");

-- CreateIndex
CREATE INDEX "intel_legiwatch_record_match_tenant_id_state_idx" ON "intel_legiwatch_record_match"("tenant_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "intel_legiwatch_record_match_tenant_id_rule_id_event_key_key" ON "intel_legiwatch_record_match"("tenant_id", "rule_id", "event_key");

-- AddForeignKey
ALTER TABLE "intel_legiwatch_delivery_recipient" ADD CONSTRAINT "intel_legiwatch_delivery_recipient_tenant_id_delivery_id_fkey" FOREIGN KEY ("tenant_id", "delivery_id") REFERENCES "intel_legiwatch_delivery"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
