-- MeriV2 Phase 0 (P0-T7): first-class Claim/Evidence store (data warehouse #5)
-- + ComplianceCheck store (warehouse #6).
--
-- ADDITIVE ONLY — three brand-new tables. No ALTER/DROP of any existing table
-- (SC0.5). All tenant-scoped with RLS, mirroring the tracked_bill /
-- notification_log isolation convention: tenant_id column + FORCE RLS policy
-- using the existing rls_bypass() / current_tenant_id() helpers, no FK to
-- tenants.

-- ── claim: attributable statements MeriV2 asserts about a subject ────────────
CREATE TABLE IF NOT EXISTS "claim" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'unknown',
    "freshness_at" TIMESTAMPTZ(6),
    "user_edited" BOOLEAN NOT NULL DEFAULT false,
    "original_statement" TEXT,
    "artifact_id" UUID,
    "transcript_segment_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "claim_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "claim_tenant_id_idx" ON "claim" ("tenant_id");
CREATE INDEX IF NOT EXISTS "claim_tenant_subject_idx" ON "claim" ("tenant_id", "subject_type", "subject_id");
CREATE INDEX IF NOT EXISTS "claim_artifact_id_idx" ON "claim" ("artifact_id");

ALTER TABLE "claim" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "claim" FORCE ROW LEVEL SECURITY;
CREATE POLICY "claim_isolation" ON "claim"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── evidence: source citations backing a claim (Appendix B canonical ids) ────
CREATE TABLE IF NOT EXISTS "evidence" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "claim_id" UUID NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "url" TEXT,
    "quote" TEXT,
    "page_number" INTEGER,
    "accessed_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "evidence_tenant_id_idx" ON "evidence" ("tenant_id");
CREATE INDEX IF NOT EXISTS "evidence_claim_id_idx" ON "evidence" ("claim_id");
ALTER TABLE "evidence"
  ADD CONSTRAINT "evidence_claim_id_fkey"
  FOREIGN KEY ("claim_id") REFERENCES "claim"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "evidence" FORCE ROW LEVEL SECURITY;
CREATE POLICY "evidence_isolation" ON "evidence"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

-- ── compliance_check: PASS/WARN/BLOCK approval-gate ledger (warehouse #6) ─────
CREATE TABLE IF NOT EXISTS "compliance_check" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "trigger" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "rule_source" TEXT,
    "required_approval" BOOLEAN NOT NULL DEFAULT false,
    "actor_user_id" TEXT,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "compliance_check_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "compliance_check_tenant_occurred_idx" ON "compliance_check" ("tenant_id", "occurred_at" DESC);
CREATE INDEX IF NOT EXISTS "compliance_check_tenant_trigger_idx" ON "compliance_check" ("tenant_id", "trigger");

ALTER TABLE "compliance_check" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "compliance_check" FORCE ROW LEVEL SECURITY;
CREATE POLICY "compliance_check_isolation" ON "compliance_check"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());
