-- Phase 8 Session 3: one additional narrow SECURITY DEFINER function for
-- capiro_defense_serve — resolving the Capiro user UUID + effective role for
-- an already-verified (tenant, clerk_user_id) pair. Session 3's mutation
-- routes (watch, data issues, alert preference, admin resolutions) need the
-- Capiro user UUID and role for FK columns and RolesGuard, and that lookup
-- runs against tenant_memberships/users, which carry FORCE ROW LEVEL
-- SECURITY. This mirrors migration 20261120200000_phase8_defense_runtime_roles's
-- three tenant-resolution functions exactly: fixed shape, minimum fields,
-- locked search_path, no caller-supplied SQL, executable by capiro_defense_serve
-- only. No generic RLS-bypass escape hatch is introduced.

CREATE OR REPLACE FUNCTION public.capiro_defense_resolve_member(
  p_tenant_id uuid,
  p_clerk_user_id text
) RETURNS TABLE(user_id uuid, role text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  RETURN QUERY
    SELECT u.id, tm.role::text
    FROM public.tenant_memberships tm
    JOIN public.users u ON u.id = tm.user_id
    WHERE tm.tenant_id = p_tenant_id
      AND u.clerk_user_id = p_clerk_user_id
      AND tm.status::text = 'active'
    LIMIT 1;
END;
$fn$;

COMMENT ON FUNCTION public.capiro_defense_resolve_member(uuid, text) IS
  'Phase 8 Session 3: the only capiro_defense_serve path to tenant_memberships/users for (userId, role) resolution. Fixed shape, minimum fields, locked search_path.';

REVOKE ALL ON FUNCTION public.capiro_defense_resolve_member(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.capiro_defense_resolve_member(uuid, text) TO capiro_defense_serve;

-- Session 3 table grants: additive, least-privilege, mirrors the Session 2
-- pattern (serve gets SELECT on read-only tables, SELECT+mutate on the
-- overlay tables the frozen contract requires). No DDL, no bypass-RLS, no
-- canonical-activation/promotion grant.
DO $grants$
DECLARE
  relation_name text;
  serve_read_relations text[] := ARRAY[
    'program_element_project',
    'program_element_project_budget_position',
    'program_element_milestone',
    'program_element_procurement_line',
    'program_element_performer',
    'federal_award',
    'congress_bill',
    'congress_bill_action',
    'congress_bill_committee',
    'bill_budget_line_link',
    'budget_package_vehicle',
    'budget_package',
    'source_document',
    'committee_report_provision',
    'provision_pe_link',
    'sam_opportunity',
    'sam_opportunity_match',
    'defense_budget_manual_override'
  ];
BEGIN
  FOREACH relation_name IN ARRAY serve_read_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_serve', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_defense_serve', relation_name);
    END IF;
  END LOOP;

  -- defense_budget_manual_override additionally needs INSERT for propose and
  -- UPDATE for approve — this is the governed overlay table, never the
  -- canonical snapshot table. No DELETE grant (records are immutable/versioned).
  IF to_regclass('public.defense_budget_manual_override') IS NOT NULL THEN
    EXECUTE 'GRANT INSERT, UPDATE ON TABLE public.defense_budget_manual_override TO capiro_defense_serve';
  END IF;

  IF to_regclass('public.audit_logs') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.audit_logs FROM capiro_defense_serve';
    EXECUTE 'GRANT SELECT, INSERT ON TABLE public.audit_logs TO capiro_defense_serve';
  END IF;

  IF to_regclass('public.program_alias') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.program_alias FROM capiro_defense_serve';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.program_alias TO capiro_defense_serve';
  END IF;

  -- DELETE is required alongside UPDATE: mergePrograms repoints the loser's
  -- matches one row at a time and must be able to drop a row that collides
  -- with one the keeper already has for the same (peCode, projectCode).
  IF to_regclass('public.pe_program_match') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.pe_program_match FROM capiro_defense_serve';
    EXECUTE 'GRANT SELECT, UPDATE, DELETE ON TABLE public.pe_program_match TO capiro_defense_serve';
  END IF;

  -- UPDATE, not DELETE: mergePrograms retires the loser program (status
  -- 'merged') rather than deleting the row, so the historical record survives
  -- and any reference this schema doesn't model on the shared physical
  -- database is never left dangling.
  IF to_regclass('public.program') IS NOT NULL THEN
    EXECUTE 'GRANT UPDATE ON TABLE public.program TO capiro_defense_serve';
  END IF;
END
$grants$;
