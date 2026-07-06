-- Freshness-layer idempotency (P1-T4): stable dedupe key on intelligence_change
-- so a same-window re-run of emit-changes never double-emits. Additive +
-- nullable — historical rows stay valid; only emit-changes populates it.
-- Mirrors the intel_alert dedupe_key pattern.
ALTER TABLE "intelligence_change" ADD COLUMN "dedupe_key" TEXT;
CREATE UNIQUE INDEX "intelligence_change_dedupe_key_key" ON "intelligence_change"("dedupe_key");
