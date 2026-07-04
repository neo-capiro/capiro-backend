-- P11 global cross-client feed roll-up. The tenant-wide feed drops the client_id
-- predicate, so the existing per-client indexes (which lead with client_id) can't
-- back its keyset scan. Add leading-tenant indexes for both orderings:
--   order=date  → (tenant_id, created_at)
--   order=score → (tenant_id, score, created_at)
-- Additive, index-only; safe to apply online.
CREATE INDEX "intel_alert_tenant_id_created_at_idx" ON "intel_alert"("tenant_id", "created_at");
CREATE INDEX "intel_alert_tenant_id_score_created_at_idx" ON "intel_alert"("tenant_id", "score", "created_at");
