-- Business Development Phase 1 tenant-isolation rehearsal.
--
-- Run against a disposable database with every Prisma migration applied:
--
--   docker exec -i capiro-postgres psql -U capiro \
--     -d capiro_bizdev_phase1_test_20260924 \
--     -f /workspace/apps/api/prisma/security-rehearsals/business-development-phase1-tenant-isolation.sql
--
-- The fixture setup uses the local master role. Every proof runs after
-- SET LOCAL ROLE capiro_app, whose non-superuser/non-BYPASSRLS properties are
-- asserted below. The transaction always rolls back.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, name, slug)
VALUES
  ('ba000000-0000-0000-0000-000000000001', 'BizDev Rehearsal A', 'bizdev-rehearsal-a'),
  ('bb000000-0000-0000-0000-000000000002', 'BizDev Rehearsal B', 'bizdev-rehearsal-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospects (
  id, tenant_id, display_name, owner_user_id, stage, status,
  conflict_excluded, conflict_reason, watch_requested, created_by_user_id
)
VALUES
  (
    'ba100000-0000-0000-0000-000000000001',
    'ba000000-0000-0000-0000-000000000001',
    'Tenant A Private Prospect',
    'ba200000-0000-0000-0000-000000000001',
    'qualified', 'active', true, 'Tenant A private reason', true,
    'ba200000-0000-0000-0000-000000000001'
  ),
  (
    'bb100000-0000-0000-0000-000000000002',
    'bb000000-0000-0000-0000-000000000002',
    'Tenant B Private Prospect',
    'bb200000-0000-0000-0000-000000000002',
    'researching', 'active', false, NULL, false,
    'bb200000-0000-0000-0000-000000000002'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospect_activity (
  id, tenant_id, prospect_id, actor_user_id, kind, body
)
VALUES
  (
    'ba300000-0000-0000-0000-000000000001',
    'ba000000-0000-0000-0000-000000000001',
    'ba100000-0000-0000-0000-000000000001',
    'ba200000-0000-0000-0000-000000000001',
    'note', 'Tenant A private note'
  ),
  (
    'bb300000-0000-0000-0000-000000000002',
    'bb000000-0000-0000-0000-000000000002',
    'bb100000-0000-0000-0000-000000000002',
    'bb200000-0000-0000-0000-000000000002',
    'note', 'Tenant B private note'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_preferences (
  id, tenant_id, practice_service_areas, agencies_issues, geographies
)
VALUES
  (
    'ba400000-0000-0000-0000-000000000001',
    'ba000000-0000-0000-0000-000000000001',
    ARRAY['appropriations'], ARRAY['defense'], ARRAY['VA']
  ),
  (
    'bb400000-0000-0000-0000-000000000002',
    'bb000000-0000-0000-0000-000000000002',
    ARRAY['regulatory'], ARRAY['energy'], ARRAY['TX']
  )
ON CONFLICT (tenant_id) DO NOTHING;

SET LOCAL ROLE capiro_app;
SELECT set_config('app.bypass_rls', 'off', true);

DO $$
DECLARE
  v_super BOOLEAN;
  v_bypass BOOLEAN;
BEGIN
  SELECT rolsuper, rolbypassrls
    INTO v_super, v_bypass
    FROM pg_roles
   WHERE rolname = current_user;
  IF current_user <> 'capiro_app' OR v_super OR v_bypass THEN
    RAISE EXCEPTION 'rehearsal must run as non-superuser/non-BYPASSRLS capiro_app';
  END IF;
END
$$;

SELECT set_config(
  'app.current_tenant',
  'ba000000-0000-0000-0000-000000000001',
  true
);

DO $$
DECLARE
  v_count INTEGER;
  v_rows INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_prospects;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A prospect visibility failed: expected 1, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count
    FROM business_development_prospects
   WHERE id = 'bb100000-0000-0000-0000-000000000002';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'tenant A read tenant B prospect';
  END IF;

  SELECT count(*) INTO v_count FROM business_development_prospect_activity;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A activity visibility failed: expected 1, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM business_development_preferences;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A preference visibility failed: expected 1, got %', v_count;
  END IF;

  UPDATE business_development_prospects
     SET display_name = 'cross-tenant mutation'
   WHERE id = 'bb100000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'tenant A updated tenant B prospect';
  END IF;

  BEGIN
    INSERT INTO business_development_preferences (
      tenant_id, practice_service_areas, agencies_issues, geographies
    ) VALUES (
      'bb000000-0000-0000-0000-000000000002', '{}', '{}', '{}'
    );
    RAISE EXCEPTION 'tenant A inserted a tenant B preference';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$$;

SELECT set_config('app.current_tenant', '', true);
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_prospects;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant context failed closed: saw % prospect rows', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_prospect_activity;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant context exposed % activity rows', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_preferences;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant context exposed % preference rows', v_count;
  END IF;
END
$$;

SELECT set_config(
  'app.current_tenant',
  'bb000000-0000-0000-0000-000000000002',
  true
);
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_prospects;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant B prospect visibility failed: expected 1, got %', v_count;
  END IF;
  SELECT count(*) INTO v_count
    FROM business_development_prospects
   WHERE id = 'ba100000-0000-0000-0000-000000000001';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'tenant B read tenant A prospect';
  END IF;
END
$$;

ROLLBACK;

SELECT 'BUSINESS DEVELOPMENT PHASE 1 RLS REHEARSAL PASSED' AS result;
