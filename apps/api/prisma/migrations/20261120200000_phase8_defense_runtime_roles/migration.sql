-- Phase 8 Session 2: additive defense service role boundary.
-- This migration creates NOLOGIN capability roles only. Production login-role
-- membership and secret rotation are deployment operations, not schema defaults.
-- It does not revoke main-api access; final revocation belongs to the cutover
-- workstream after shadow/canary acceptance.

DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
    CREATE ROLE capiro_defense_serve
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job') THEN
    CREATE ROLE capiro_defense_job
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  END IF;
END
$roles$;

ALTER ROLE capiro_defense_serve SET statement_timeout = '15s';
ALTER ROLE capiro_defense_serve SET lock_timeout = '3s';
ALTER ROLE capiro_defense_serve SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE capiro_defense_job SET statement_timeout = '15min';
ALTER ROLE capiro_defense_job SET lock_timeout = '5s';
ALTER ROLE capiro_defense_job SET idle_in_transaction_session_timeout = '60s';

REVOKE ALL ON SCHEMA public FROM capiro_defense_serve, capiro_defense_job;
GRANT USAGE ON SCHEMA public TO capiro_defense_serve, capiro_defense_job;

DO $grants$
DECLARE
  relation_name text;
  -- tenants/users/tenant_memberships are deliberately absent here. tenants and
  -- tenant_memberships carry FORCE ROW LEVEL SECURITY policies that only open
  -- for the current tenant (see current_tenant_id()/rls_bypass() in migration
  -- 20260501000000), so a bootstrap "which tenant is this Clerk org" lookup
  -- cannot be served by a direct table grant at all -- it runs before
  -- app.current_tenant is known. That lookup is served instead by the narrow
  -- SECURITY DEFINER functions below, which are the only tenant/membership
  -- access capiro_defense_serve holds.
  serve_read_relations text[] := ARRAY[
    'program_element',
    'program_element_source',
    'program_element_project',
    'program_element_year',
    'program_element_budget_position',
    'program_element_project_budget_position',
    'program_element_delta',
    'program_element_milestone',
    'program_element_milestone_schedule_period',
    'program_element_procurement_line',
    'program_element_performer',
    'program_element_intelligence_cache',
    'program',
    'program_alias',
    'pe_program_match',
    'budget_line_relationship',
    'defense_budget_active_snapshot',
    -- Read-only, so /readyz (and any future canonical read) can join the
    -- active pointer to its snapshot and confirm the snapshot it points at is
    -- still valid, without granting anything from the promotion surface.
    'defense_budget_canonical_snapshot',
    'defense_budget_program_element_snapshot'
  ];
  serve_overlay_relations text[] := ARRAY[
    'program_element_watch',
    'program_element_data_issue',
    'pe_alert_email_pref',
    'reconciliation_review_queue'
  ];
  job_relations text[] := ARRAY[
    'program_element_ingest_run',
    'program_element_quarantine',
    'program_element_year_source_value',
    'program_element_change_outbox',
    'program_element_delta',
    'program_element_milestone',
    'program_element_milestone_schedule_period',
    'program_element_procurement_line',
    'program_element_performer',
    'reconciliation_review_queue'
  ];
BEGIN
  FOREACH relation_name IN ARRAY serve_read_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_serve', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_defense_serve', relation_name);
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY serve_overlay_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_serve', relation_name);
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO capiro_defense_serve',
        relation_name
      );
    END IF;
  END LOOP;

  FOREACH relation_name IN ARRAY job_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_job', relation_name);
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO capiro_defense_job',
        relation_name
      );
    END IF;
  END LOOP;

  -- Jobs may read the immutable/source-side inputs needed to build candidates,
  -- but may not activate a canonical snapshot.
  FOREACH relation_name IN ARRAY serve_read_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL
       AND relation_name <> 'defense_budget_active_snapshot' THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_defense_job', relation_name);
    END IF;
  END LOOP;
END
$grants$;

DO $sequences$
DECLARE
  sequence_name text;
BEGIN
  FOR sequence_name IN
    SELECT quote_ident(s.sequence_schema) || '.' || quote_ident(s.sequence_name)
    FROM information_schema.sequences AS s
    WHERE s.sequence_schema = 'public'
      AND (
        s.sequence_name LIKE 'program_element_%'
        OR s.sequence_name LIKE 'reconciliation_review_queue_%'
      )
  LOOP
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO capiro_defense_serve, capiro_defense_job',
      sequence_name
    );
  END LOOP;
END
$sequences$;

-- Explicitly preserve promoter isolation.
REVOKE ALL ON TABLE defense_budget_active_snapshot
  FROM capiro_defense_serve, capiro_defense_job;
GRANT SELECT ON TABLE defense_budget_active_snapshot TO capiro_defense_serve;

COMMENT ON ROLE capiro_defense_serve IS
  'Phase 8 defense HTTP capability role; no login, DDL, bypass-RLS, parser, or promotion authority.';
COMMENT ON ROLE capiro_defense_job IS
  'Phase 8 defense ingestion/job capability role; no login, DDL, bypass-RLS, or canonical activation authority.';

-- ---------------------------------------------------------------------------
-- Narrow tenant/membership resolution for capiro_defense_serve
-- ---------------------------------------------------------------------------
-- The HTTP boundary must resolve "which tenant is this Clerk org" and "is this
-- Clerk user an active member of that tenant" before app.current_tenant is
-- known, which is exactly the bootstrap problem tenants/tenant_memberships'
-- FORCE ROW LEVEL SECURITY policies are designed to block (migration
-- 20260501000000: rows are visible only to the current tenant or under
-- rls_bypass()). A generic bypass method on the Prisma service that lets any
-- future caller run arbitrary raw SQL under app.bypass_rls would defeat the
-- least-privilege HTTP boundary Session 2 exists to build, so the only escape
-- hatch is these three fixed-shape, minimum-field SECURITY DEFINER functions.
-- Each: runs with a locked, empty search_path and fully qualified names (the
-- standard defense against search-path hijack of a SECURITY DEFINER
-- function); returns only the columns the resolver needs; accepts no
-- caller-supplied SQL, only typed scalar arguments; is executable by nobody
-- except capiro_defense_serve.

CREATE OR REPLACE FUNCTION public.capiro_defense_resolve_tenant_by_clerk_org(
  p_clerk_org_id text
) RETURNS TABLE(id uuid, slug text, clerk_org_id text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY
    SELECT t.id, t.slug::text, t.clerk_org_id
    FROM public.tenants t
    WHERE t.clerk_org_id = p_clerk_org_id
    LIMIT 1;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.capiro_defense_resolve_tenant_by_id(
  p_tenant_id uuid
) RETURNS TABLE(id uuid, slug text, clerk_org_id text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY
    SELECT t.id, t.slug::text, t.clerk_org_id
    FROM public.tenants t
    WHERE t.id = p_tenant_id
    LIMIT 1;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.capiro_defense_has_active_membership(
  p_tenant_id uuid,
  p_clerk_user_id text
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  found boolean;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT true INTO found
    FROM public.tenant_memberships tm
    JOIN public.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
      AND u.clerk_user_id = p_clerk_user_id
      AND tm.status::text = 'active'
    LIMIT 1;
  RETURN coalesce(found, false);
END;
$fn$;

COMMENT ON FUNCTION public.capiro_defense_resolve_tenant_by_clerk_org(text) IS
  'Phase 8 Session 2: the only capiro_defense_serve path to the tenants table. Fixed shape, minimum fields, locked search_path.';
COMMENT ON FUNCTION public.capiro_defense_resolve_tenant_by_id(uuid) IS
  'Phase 8 Session 2: the only capiro_defense_serve path to the tenants table by id. Fixed shape, minimum fields, locked search_path.';
COMMENT ON FUNCTION public.capiro_defense_has_active_membership(uuid, text) IS
  'Phase 8 Session 2: the only capiro_defense_serve path to tenant_memberships/users. Returns a boolean only.';

REVOKE ALL ON FUNCTION public.capiro_defense_resolve_tenant_by_clerk_org(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capiro_defense_resolve_tenant_by_id(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capiro_defense_has_active_membership(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.capiro_defense_resolve_tenant_by_clerk_org(text)
  TO capiro_defense_serve;
GRANT EXECUTE ON FUNCTION public.capiro_defense_resolve_tenant_by_id(uuid)
  TO capiro_defense_serve;
GRANT EXECUTE ON FUNCTION public.capiro_defense_has_active_membership(uuid, text)
  TO capiro_defense_serve;

-- capiro_defense_job performs no request-time tenant resolution and holds no
-- execute grant on any of the three functions above.
