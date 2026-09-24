-- Business Development Phase 2 candidate-marker tenant isolation.
--
-- Run against a disposable database with all migrations applied. Fixture
-- setup uses the local owner; every proof runs as the non-bypass capiro_app
-- role. The transaction always rolls back.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO tenants (id, name, slug)
VALUES
  ('ca000000-0000-0000-0000-000000000001', 'BizDev Phase 2 A', 'bizdev-phase2-a'),
  ('cb000000-0000-0000-0000-000000000002', 'BizDev Phase 2 B', 'bizdev-phase2-b')
ON CONFLICT (id) DO NOTHING;

INSERT INTO canonical_entities (
  id, identity_scope, entity_type, canonical_name, normalized_name,
  resolution_method
)
VALUES (
  'cc000000-0000-0000-0000-000000000003',
  'global_public', 'organization', 'Shared Public Candidate',
  'shared public candidate', 'manual_review'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospects (
  id, tenant_id, canonical_entity_id, display_name, stage, status,
  conflict_excluded, conflict_reason, watch_requested
)
VALUES
  (
    'ca100000-0000-0000-0000-000000000001',
    'ca000000-0000-0000-0000-000000000001',
    'cc000000-0000-0000-0000-000000000003',
    'Tenant A Candidate State', 'qualified', 'active', true,
    'Tenant A private conflict detail', true
  ),
  (
    'cb100000-0000-0000-0000-000000000002',
    'cb000000-0000-0000-0000-000000000002',
    'cc000000-0000-0000-0000-000000000003',
    'Tenant B Candidate State', 'researching', 'active', false, NULL, false
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_development_prospect_activity (
  id, tenant_id, prospect_id, kind, body
)
VALUES
  (
    'ca200000-0000-0000-0000-000000000001',
    'ca000000-0000-0000-0000-000000000001',
    'ca100000-0000-0000-0000-000000000001',
    'note', 'Tenant A private note body'
  ),
  (
    'cb200000-0000-0000-0000-000000000002',
    'cb000000-0000-0000-0000-000000000002',
    'cb100000-0000-0000-0000-000000000002',
    'note', 'Tenant B private note body'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO clients (id, tenant_id, name, canonical_entity_id)
VALUES
  (
    'ca300000-0000-0000-0000-000000000001',
    'ca000000-0000-0000-0000-000000000001',
    'Tenant A Client Marker',
    'cc000000-0000-0000-0000-000000000003'
  ),
  (
    'cb300000-0000-0000-0000-000000000002',
    'cb000000-0000-0000-0000-000000000002',
    'Tenant B Client Marker',
    'cc000000-0000-0000-0000-000000000003'
  )
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE capiro_app;
SELECT set_config('app.bypass_rls', 'off', true);

DO $$
DECLARE
  v_super BOOLEAN;
  v_bypass BOOLEAN;
BEGIN
  SELECT rolsuper, rolbypassrls INTO v_super, v_bypass
    FROM pg_roles WHERE rolname = current_user;
  IF current_user <> 'capiro_app' OR v_super OR v_bypass THEN
    RAISE EXCEPTION 'rehearsal must run as non-superuser/non-BYPASSRLS capiro_app';
  END IF;
END
$$;

SELECT set_config('app.current_tenant', 'ca000000-0000-0000-0000-000000000001', true);

DO $$
DECLARE
  v_count INTEGER;
  v_rows INTEGER;
  v_prospect_names TEXT[];
  v_client_names TEXT[];
BEGIN
  SELECT count(*) INTO v_count FROM business_development_prospects;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A prospect marker visibility failed: expected 1, got %', v_count;
  END IF;

  SELECT count(*) INTO v_count FROM clients
   WHERE canonical_entity_id = 'cc000000-0000-0000-0000-000000000003';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A client marker visibility failed: expected 1, got %', v_count;
  END IF;

  -- Mirrors the Phase 2 candidate-marker join shape: the canonical source is
  -- global, while prospect/client marker rows are filtered by FORCE RLS.
  SELECT array_agg(p.display_name), array_agg(c.name)
    INTO v_prospect_names, v_client_names
    FROM canonical_entities ce
    LEFT JOIN business_development_prospects p
      ON p.canonical_entity_id = ce.id
    LEFT JOIN clients c
      ON c.canonical_entity_id = ce.id
   WHERE ce.id = 'cc000000-0000-0000-0000-000000000003';

  IF v_prospect_names <> ARRAY['Tenant A Candidate State']::TEXT[] OR
     v_client_names <> ARRAY['Tenant A Client Marker']::TEXT[] THEN
    RAISE EXCEPTION 'tenant A marker join leaked or omitted private state: prospects %, clients %',
      v_prospect_names, v_client_names;
  END IF;

  SELECT count(*) INTO v_count FROM business_development_prospect_activity;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'tenant A activity visibility failed: expected 1, got %', v_count;
  END IF;

  UPDATE business_development_prospects
     SET display_name = 'cross-tenant mutation'
   WHERE id = 'cb100000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'tenant A updated tenant B prospect';
  END IF;
END
$$;

SELECT set_config('app.current_tenant', '', true);
DO $$
DECLARE v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count FROM business_development_prospects;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant exposed % prospects', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM clients
   WHERE canonical_entity_id = 'cc000000-0000-0000-0000-000000000003';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant exposed % clients', v_count;
  END IF;
  SELECT count(*) INTO v_count FROM business_development_prospect_activity;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'unset tenant exposed % activity rows', v_count;
  END IF;
END
$$;

SELECT set_config('app.current_tenant', 'cb000000-0000-0000-0000-000000000002', true);
DO $$
DECLARE
  v_prospect_names TEXT[];
  v_client_names TEXT[];
BEGIN
  SELECT array_agg(p.display_name), array_agg(c.name)
    INTO v_prospect_names, v_client_names
    FROM canonical_entities ce
    LEFT JOIN business_development_prospects p
      ON p.canonical_entity_id = ce.id
    LEFT JOIN clients c
      ON c.canonical_entity_id = ce.id
   WHERE ce.id = 'cc000000-0000-0000-0000-000000000003';

  IF v_prospect_names <> ARRAY['Tenant B Candidate State']::TEXT[] OR
     v_client_names <> ARRAY['Tenant B Client Marker']::TEXT[] THEN
    RAISE EXCEPTION 'tenant B marker join leaked or omitted private state: prospects %, clients %',
      v_prospect_names, v_client_names;
  END IF;
END
$$;

ROLLBACK;

SELECT 'BUSINESS DEVELOPMENT PHASE 2 TENANT MARKER RLS REHEARSAL PASSED' AS result;
