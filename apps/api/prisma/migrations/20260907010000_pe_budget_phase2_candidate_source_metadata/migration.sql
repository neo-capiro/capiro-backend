-- Phase 7 Gap 5, decision 1 — denormalize the two source-metadata facts a
-- promotion eligibility evaluation needs onto the Phase 2 candidate row.
--
-- INHERITED PREREQUISITE DEFECT, not a Phase 7 feature. Recorded plainly so
-- nobody later reads this as "Phase 7 wanted extra columns":
--
-- `budget_extraction_candidate_v1` records ten hashes describing a candidate's
-- exact immutable identity, but not the budget family the document belongs to
-- and not the extraction method that produced it. Both were known, resolved,
-- and verified at the moment the row was written — `persistCompletedVerification`
-- is called with the fully resolved `DefenseBudgetExtractionArtifactV1` in
-- scope (budget-verification-v1.service.ts) — and both were simply not stored.
--
-- The consequence surfaced in Phase 7: `PromotionEligibilityRepositoryV1`
-- cannot honour its own `(cycleId, families)` scoping without `family`, and
-- `deriveSegregationEvidenceV1` cannot evaluate the authorizer-equals-extractor
-- control without `extractionMethod` (it feeds `isHighRiskExtractionMethodV1`).
-- Defaulting either one would make a mandatory negative control vacuous, so the
-- repair belongs here rather than as a guess at read time. See Gap 5 in
-- docs/defense-budget/PHASE-7-ARCHITECTURE-GAPS.md.
--
-- Purely additive and nullable. NULL means "written before this migration and
-- not yet backfilled", which every reader must treat as a refusal rather than
-- as a wildcard — the backfill
-- (scripts/backfill-budget-candidate-source-metadata-v1.ts) resolves each
-- candidate's stored artifact locator, verifies the artifact bytes against the
-- candidate's existing `extraction_artifact_sha256`, and only then writes these
-- two columns. It fails closed on an unavailable artifact or a hash mismatch.
--
-- Deliberately no CHECK constraint on either column: the sibling `status`
-- column stores its vocabulary as plain TEXT validated in code, and matching
-- that keeps this migration additive-only. Both values are re-parsed through
-- their Zod enums on read.

ALTER TABLE "budget_extraction_candidate_v1"
    ADD COLUMN "family"            TEXT,
    ADD COLUMN "extraction_method" TEXT;

-- The eligibility read is always scoped by cycle and family together
-- (`loadCandidates(cycleId, families)`), so the composite matches the query
-- rather than leaving it to filter a whole cycle in memory.
CREATE INDEX "budget_v1_candidate_cycle_family_idx"
    ON "budget_extraction_candidate_v1" ("cycle_id", "family");
