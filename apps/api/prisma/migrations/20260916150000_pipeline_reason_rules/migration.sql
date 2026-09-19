-- Pipeline product rule correction: only Lost and Passed require a selected reason.
-- Do not edit the already-applied P35 migration.
ALTER TABLE "funding_opportunity_stage_transition"
  DROP CONSTRAINT IF EXISTS "funding_opportunity_stage_transition_reason_chk";

ALTER TABLE "funding_opportunity_stage_transition"
  ADD CONSTRAINT "funding_opportunity_stage_transition_reason_chk"
  CHECK (
    "to_stage" NOT IN ('lost', 'passed')
    OR ("reason" IS NOT NULL AND btrim("reason") <> '')
  );