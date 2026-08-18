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

-- ---------------------------------------------------------------------------
-- Workstream E full-surface read grants.
--
-- The 49-route contract serves materially more than the previous curated set:
-- the finder's per-row enrichment (bill counts from the detail MV, intelligence
-- cache, capability facets), the Budget Lines money-graph modules (budget
-- actions, capabilities), the timeline's cached conference forecast, and the
-- related-PE / capability-search vector reads.
--
-- Everything below is SELECT-ONLY, with two deliberate exceptions called out
-- inline (person_role, program_office_program_link) that a program MERGE must
-- re-point. Specifically NOT granted, and asserted absent by the rehearsal:
--   * INSERT/UPDATE on conference_probability - the HTTP read path computes a
--     forecast in memory and must never persist one (GAI-25). The database, not
--     just the code, enforces that.
--   * anything on the promotion / canonical-snapshot surface.
--   * DDL, bypass-RLS, or promoter role membership.
-- ---------------------------------------------------------------------------
DO $e_grants$
DECLARE
  relation_name text;
  serve_read_relations text[] := ARRAY[
    -- finder + profile enrichment
    'program_element_detail_mv',
    'program_element_acquisition_program',
    'conference_probability',
    -- NOTE: context_embeddings is deliberately ABSENT. Its FORCE-RLS policy
    -- references clients / client_memory_access, and PostgreSQL requires
    -- privileges on every table a policy expression touches -- so a table grant
    -- here fails at read time with "permission denied for table clients" (proven
    -- by the Session 3 rehearsal). It is served by the two SECURITY DEFINER
    -- functions at the end of this migration instead.
    -- Budget Lines money-graph modules
    'budget_action',
    'capability',
    'capability_budget_line_match'
  ];
BEGIN
  FOREACH relation_name IN ARRAY serve_read_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_serve', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_defense_serve', relation_name);
    END IF;
  END LOOP;

  -- A program merge must re-point every FK table that references the losing
  -- program, or the merged program's people, offices and report language silently
  -- vanish from every view that joins through them. person_role has no unique on
  -- program_id (straight UPDATE); program_office_program_link and
  -- provision_pe_link do, so a colliding row is DELETEd instead of re-pointed.
  --
  -- No SELECT-on-PII concern: only the FK column is ever read or written here,
  -- and no route in the frozen contract surfaces a person.
  IF to_regclass('public.person_role') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.person_role FROM capiro_defense_serve';
    EXECUTE 'GRANT SELECT, UPDATE ON TABLE public.person_role TO capiro_defense_serve';
  END IF;

  IF to_regclass('public.program_office_program_link') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.program_office_program_link FROM capiro_defense_serve';
    EXECUTE 'GRANT SELECT, UPDATE, DELETE ON TABLE public.program_office_program_link TO capiro_defense_serve';
  END IF;

  IF to_regclass('public.provision_pe_link') IS NOT NULL THEN
    EXECUTE 'GRANT UPDATE, DELETE ON TABLE public.provision_pe_link TO capiro_defense_serve';
  END IF;
END
$e_grants$;
-- ---------------------------------------------------------------------------
-- PE mission-vector reads, via two narrow SECURITY DEFINER functions.
--
-- WHY NOT A PLAIN GRANT: `context_embeddings` carries FORCE ROW LEVEL SECURITY
-- whose policy reaches into `clients` and `client_memory_access` (the client
-- memory-wall rules). PostgreSQL requires privileges on every table a policy
-- expression references, so a bare `GRANT SELECT ON context_embeddings` yields
-- "permission denied for table clients" on the FIRST read -- proven by the
-- Session 3 disposable rehearsal. Making it work by granting
-- capiro_defense_serve read access to `clients` would hand the defense HTTP role
-- the CRM's client list to serve a similarity suggestion. That is precisely the
-- cross-domain coupling Workstream E exists to remove.
--
-- These two functions are the bounded alternative, and follow the pattern
-- Session 2 established with capiro_defense_resolve_member:
--   * fixed shape -- they return (pe_code, score) and nothing else;
--   * hard-scoped to source_type='pe' AND tenant_id IS NULL, which is exactly the
--     GLOBAL reference-data partition embed-program-elements writes
--     (`tenantId: null`), so no tenant-scoped or client-scoped vector is reachable
--     even in principle;
--   * STABLE, so neither can write anything;
--   * EXECUTE granted to capiro_defense_serve only.
-- capiro_defense_serve gets NO direct grant on context_embeddings.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.capiro_defense_related_pe_vectors(
  p_pe_code text,
  p_model text,
  p_floor double precision,
  p_limit integer
)
RETURNS TABLE (pe_code text, score double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH src AS (
    SELECT ce.embedding
    FROM context_embeddings ce
    WHERE ce.source_type = 'pe'
      AND ce.tenant_id IS NULL
      AND ce.source_id = p_pe_code
      AND ce.model = p_model
      AND ce.embedding IS NOT NULL
    LIMIT 1
  )
  SELECT ce.source_id::text AS pe_code,
         (1 - (ce.embedding <=> (SELECT embedding FROM src)))::double precision AS score
  FROM context_embeddings ce
  JOIN program_element pe ON pe.pe_code = ce.source_id
  WHERE ce.source_type = 'pe'
    AND ce.tenant_id IS NULL
    AND ce.model = p_model
    AND ce.embedding IS NOT NULL
    AND ce.source_id <> p_pe_code
    AND pe.retired_at IS NULL
    AND EXISTS (SELECT 1 FROM src)
    AND (1 - (ce.embedding <=> (SELECT embedding FROM src))) >= p_floor
  ORDER BY ce.embedding <=> (SELECT embedding FROM src)
  LIMIT p_limit;
$fn$;

CREATE OR REPLACE FUNCTION public.capiro_defense_search_pe_vectors(
  p_query_vector text,
  p_model text,
  p_floor double precision,
  p_limit integer
)
RETURNS TABLE (pe_code text, score double precision)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT ce.source_id::text AS pe_code,
         (1 - (ce.embedding <=> p_query_vector::vector))::double precision AS score
  FROM context_embeddings ce
  JOIN program_element pe ON pe.pe_code = ce.source_id
  WHERE ce.source_type = 'pe'
    AND ce.tenant_id IS NULL
    AND ce.model = p_model
    AND ce.embedding IS NOT NULL
    AND pe.retired_at IS NULL
    AND (1 - (ce.embedding <=> p_query_vector::vector)) >= p_floor
  ORDER BY ce.embedding <=> p_query_vector::vector
  LIMIT p_limit;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_related_pe_vectors(text, text, double precision, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.capiro_defense_search_pe_vectors(text, text, double precision, integer) FROM PUBLIC;

DO $vec_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_related_pe_vectors(text, text, double precision, integer) TO capiro_defense_serve';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_search_pe_vectors(text, text, double precision, integer) TO capiro_defense_serve';
  END IF;
  -- No direct table grant: the RLS policy on context_embeddings references
  -- CRM-owned tables, so a table grant cannot work without also granting those.
  IF to_regclass('public.context_embeddings') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.context_embeddings FROM capiro_defense_serve';
  END IF;
END
$vec_grants$;
