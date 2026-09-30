-- Use the same transaction-local tenant identity as PrismaService.withTenant.
DROP POLICY "research_portfolio_subscription_deliveries_tenant_isolation"
  ON "research_portfolio_subscription_deliveries";
CREATE POLICY "research_portfolio_subscription_deliveries_tenant_isolation"
  ON "research_portfolio_subscription_deliveries"
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'research_portfolio_bookmarks',
    'research_portfolio_tour_states',
    'research_portfolio_review_notes'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())', table_name || '_isolation', table_name);
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON research_portfolio_bookmarks, research_portfolio_tour_states TO capiro_app;
    GRANT SELECT, INSERT ON research_portfolio_review_notes TO capiro_app;
  END IF;
END;
$$;
