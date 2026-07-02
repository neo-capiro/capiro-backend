-- Phase 6 (§9.4/§9.5/§9.8): additive, backward-compatible. Adds the alert
-- idempotency key (nullable unique) + the feed score-ordering index. No changes
-- to existing columns/rows; existing intel_alert rows keep dedupe_key = NULL.

-- AlterTable
ALTER TABLE "intel_alert" ADD COLUMN "dedupe_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "intel_alert_dedupe_key_key" ON "intel_alert"("dedupe_key");

-- CreateIndex
CREATE INDEX "intel_alert_tenant_id_client_id_score_created_at_idx" ON "intel_alert"("tenant_id", "client_id", "score", "created_at");
