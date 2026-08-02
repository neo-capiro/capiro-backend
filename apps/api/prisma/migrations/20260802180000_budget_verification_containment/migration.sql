-- Phase 0 containment for the budget structural-validation scaffold.
-- Additive only. Renames misleading scaffold statuses and tightens vocabulary.
-- No canonical Program Element table is altered; no canonical promotion authority exists.

-- F1: fail closed if any candidate row was ever marked CANONICAL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM budget_extraction_candidate
    WHERE status = 'CANONICAL'
  ) THEN
    RAISE EXCEPTION 'budget verification containment refused: CANONICAL candidate rows already exist';
  END IF;
END $$;

-- F2/F3: swap the candidate status constraint to a superset that admits both the old
-- and new scaffold statuses, remap in place, then tighten to the final vocabulary.
ALTER TABLE "budget_extraction_candidate"
  DROP CONSTRAINT "budget_extraction_candidate_status_check";

ALTER TABLE "budget_extraction_candidate"
  ADD CONSTRAINT "budget_extraction_candidate_status_check"
  CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'STRUCTURALLY_VALIDATED',
                      'NEEDS_REVIEW', 'REVIEW_ACCEPTED', 'REJECTED',
                      'SUPERSEDED', 'VERIFIED_AUTOMATIC', 'VERIFIED_REVIEWED'));

UPDATE "budget_extraction_candidate"
   SET "status" = 'STRUCTURALLY_VALIDATED'
 WHERE "status" = 'VERIFIED_AUTOMATIC';

UPDATE "budget_extraction_candidate"
   SET "status" = 'REVIEW_ACCEPTED'
 WHERE "status" = 'VERIFIED_REVIEWED';

UPDATE "budget_verification_run"
   SET "status" = 'STRUCTURALLY_VALIDATED'
 WHERE "status" = 'VERIFIED_AUTOMATIC';

UPDATE "budget_verification_run"
   SET "status" = 'REVIEW_ACCEPTED'
 WHERE "status" = 'VERIFIED_REVIEWED';

ALTER TABLE "budget_extraction_candidate"
  DROP CONSTRAINT "budget_extraction_candidate_status_check";

ALTER TABLE "budget_extraction_candidate"
  ADD CONSTRAINT "budget_extraction_candidate_status_check"
  CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'STRUCTURALLY_VALIDATED',
                      'NEEDS_REVIEW', 'REVIEW_ACCEPTED', 'REJECTED',
                      'SUPERSEDED'));

-- F4: controlled vocabulary for run status and route.
ALTER TABLE "budget_verification_run"
  ADD CONSTRAINT "budget_verification_run_status_check"
  CHECK ("status" IN ('EXTRACTED', 'VALIDATING', 'STRUCTURALLY_VALIDATED',
                      'NEEDS_REVIEW', 'REVIEW_ACCEPTED', 'REJECTED',
                      'SUPERSEDED'));

ALTER TABLE "budget_verification_run"
  ADD CONSTRAINT "budget_verification_run_route_check"
  CHECK ("route" IN ('automatic', 'targeted_local_reextraction',
                     'paid_page_verifier', 'human_review', 'none'));

-- F5: honest table comments.
COMMENT ON TABLE "budget_extraction_candidate" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_extraction_cell" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_run" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_check" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_verification_discrepancy" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_review_decision" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
COMMENT ON TABLE "budget_golden_example" IS
  'Structural-validation audit records only. No canonical Program Element promotion authority.';
