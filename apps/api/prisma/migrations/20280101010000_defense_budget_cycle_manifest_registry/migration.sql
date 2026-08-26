-- Phase 10B-2D: durable manifest registry.
--
-- Stores the governed BudgetCycleManifestV1 verbatim, keyed by
-- (cycle_id, manifest_content_sha256), so a fresh process can reload the
-- exact manifest a corpus was evaluated against by content hash alone --
-- see the Prisma model's own doc comment for the restart-safety rationale.
CREATE TABLE "defense_budget_cycle_manifest_registry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "cycle_id" TEXT NOT NULL,
    "manifest_content_sha256" CHAR(64) NOT NULL,
    "fiscal_year" INTEGER NOT NULL,
    "manifest_document_jsonb" JSONB NOT NULL,
    "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "defense_budget_cycle_manifest_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dbcmr_cycle_manifest_hash_key" ON "defense_budget_cycle_manifest_registry"("cycle_id", "manifest_content_sha256");

CREATE INDEX "dbcmr_cycle_recent_idx" ON "defense_budget_cycle_manifest_registry"("cycle_id", "registered_at" DESC);
