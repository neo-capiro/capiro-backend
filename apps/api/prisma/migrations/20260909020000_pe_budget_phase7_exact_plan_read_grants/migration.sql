-- Phase 7 repair — least-privilege reads required by exact producer-plan reload.
--
-- The original role design intentionally gave capiro_pe_promoter no access to
-- defense_budget_promotion_eligibility because execution used only its hash,
-- and defense_budget_projection_plan did not exist yet. Phase 7 now correctly
-- reloads the exact immutable eligibility + producer plans during execution, so
-- the promoter needs SELECT and nothing more on those evidence tables.
--
-- The Phase 6 certification-binding table is owned by a separate migration
-- chain. Grant it conditionally here so either main-chain/Phase6-chain ordering
-- yields the same least-privilege end state; the Phase 6 migration performs the
-- symmetric conditional grant when the promoter role already exists.

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
  "defense_budget_promotion_eligibility",
  "defense_budget_projection_plan"
FROM capiro_pe_promoter;

GRANT SELECT ON
  "defense_budget_promotion_eligibility",
  "defense_budget_projection_plan"
TO capiro_pe_promoter;

DO $$
BEGIN
  IF to_regclass('public.phase6_cycle_certification_projection') IS NOT NULL THEN
    EXECUTE 'GRANT SELECT ON public.phase6_cycle_certification_projection TO capiro_pe_promoter';
  END IF;
END
$$;
