-- The compiled budget-lifecycle coverage query reads bundle members through
-- the SELECT-only defense serving role. Keep this read grant narrow and
-- conditional so migration history also applies where that runtime role has
-- not yet been provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
    GRANT SELECT ON TABLE "defense_budget_source_bundle_member" TO "capiro_defense_serve";
  END IF;
END
$$;
