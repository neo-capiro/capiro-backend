-- Repair Fill with Meri RLS policies.
-- The original migration checked current_setting('app.tenant_id'), but
-- PrismaService.withTenant sets app.current_tenant (via current_tenant_id()).
-- That mismatch rejects every INSERT under FORCE RLS (Postgres 42501 → API 500).
-- Align with the canonical tenant RLS helpers used by other client_* tables.

DROP POLICY IF EXISTS client_profile_fill_run_select ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_select ON client_profile_fill_run
  FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_run_insert ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_insert ON client_profile_fill_run
  FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_run_update ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_update ON client_profile_fill_run
  FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_run_delete ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_delete ON client_profile_fill_run
  FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_finding_select ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_select ON client_profile_fill_finding
  FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_finding_insert ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_insert ON client_profile_fill_finding
  FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_finding_update ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_update ON client_profile_fill_finding
  FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_finding_delete ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_delete ON client_profile_fill_finding
  FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());
