-- Phase 7 repair — least-privilege reads required by exact producer-plan reload.
--
-- The original role design intentionally gave capiro_pe_promoter no access to
-- defense_budget_promotion_eligibility because execution used only its hash,
-- and defense_budget_projection_plan did not exist yet. Phase 7 now correctly
-- reloads the exact immutable eligibility + producer plans during execution, so
-- the promoter needs SELECT and nothing more on those evidence tables.
--
-- Every grant is conditional because the Phase 7 rehearsal intentionally
-- constructs a synthetic pre-Phase-7 migration baseline by omitting the earlier
-- Phase 7 migrations. On a real upgrade (where those migrations already ran)
-- and on a full fresh replay, all required objects exist and the grants apply.
-- The Phase 6 association is owned by a separate migration chain; that chain
-- performs the symmetric conditional grant when it runs after the promoter.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_pe_promoter') THEN
    IF to_regclass('public.defense_budget_promotion_eligibility') IS NOT NULL THEN
      EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.defense_budget_promotion_eligibility FROM capiro_pe_promoter';
      EXECUTE 'GRANT SELECT ON public.defense_budget_promotion_eligibility TO capiro_pe_promoter';
    END IF;

    IF to_regclass('public.defense_budget_projection_plan') IS NOT NULL THEN
      EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.defense_budget_projection_plan FROM capiro_pe_promoter';
      EXECUTE 'GRANT SELECT ON public.defense_budget_projection_plan TO capiro_pe_promoter';
    END IF;

    IF to_regclass('public.phase6_cycle_certification_projection') IS NOT NULL THEN
      EXECUTE 'GRANT SELECT ON public.phase6_cycle_certification_projection TO capiro_pe_promoter';
    END IF;
  END IF;
END
$$;
