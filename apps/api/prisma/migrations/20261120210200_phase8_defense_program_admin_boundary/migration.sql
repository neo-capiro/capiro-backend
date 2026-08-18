-- Phase 8 Session 3 — governed Program-graph admin boundary.
--
-- Consolidation note: the security model in this migration originates from the
-- concurrent Session 3 branch (PR #1044). It is ported here on top of the gated
-- Session 3 implementation, deliberately WITHOUT that branch's overlapping
-- rewrite of the Program Elements / Budget Lines / funding / timeline /
-- provenance read services.
--
-- The problem it solves: the preceding dark migration granted
-- capiro_defense_serve direct INSERT/UPDATE/DELETE on the GLOBAL Program graph
-- (program, program_alias, pe_program_match, person_role,
-- program_office_program_link, provision_pe_link) so the admin routes could
-- write. Those tables carry no tenant_id and no RLS, so a direct DML grant means
-- the ONLY thing standing between any authenticated request and a global graph
-- mutation is the application's own role check. A bug in a guard, a new route
-- that forgets @Roles('capiro_admin'), or a compromised HTTP task is then enough.
--
-- After this migration:
--   * capiro_defense_serve is SELECT-only on every global Program graph table.
--   * Every mutation goes through a fixed-shape SECURITY DEFINER function that
--     RE-CHECKS an active capiro_admin membership in the database at execution
--     time, independently of the application.
--   * Each function takes only scalar parameters (no caller-supplied SQL), uses
--     fully-qualified object names under a locked empty search_path, is revoked
--     from PUBLIC, and is granted to capiro_defense_serve alone.
--
-- Merge semantics are identical to the gated implementation's tested behaviour,
-- including the detail that a loser alias whose (alias_normalized, alias_type)
-- the keeper already holds STAYS with the retired loser rather than being
-- deleted — that is apps/api's behaviour (`continue`, not delete), and the
-- gated branch's DB-backed regression test pins it.
--
-- Migration-from-zero safe: the functions below are defined before any
-- invocation, and no data is mutated here.

-- ---------------------------------------------------------------------------
-- 1. The in-database admin gate.
-- ---------------------------------------------------------------------------
-- tenant_memberships carries FORCE ROW LEVEL SECURITY whose policy only opens
-- for the current tenant, and the membership lookup has to run before any tenant
-- GUC is meaningful — so this reads with app.bypass_rls set transaction-locally,
-- exactly as Session 2's already-merged capiro_defense_resolve_member does.
--
-- Difference from PR #1044's version: the prior value is saved and RESTORED
-- rather than left on. #1044's function leaves app.bypass_rls='on' for the
-- remainder of the caller's transaction; because these functions are called from
-- inside a request, any subsequent read in that same transaction would then run
-- with RLS bypassed. Restoring keeps the widening scoped to the check itself.
CREATE OR REPLACE FUNCTION public.capiro_defense_require_admin(
  p_tenant_id uuid,
  p_actor_user_id uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_prior text := current_setting('app.bypass_rls', true);
  v_is_admin boolean;
BEGIN
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_memberships tm
    WHERE tm.tenant_id = p_tenant_id
      AND tm.user_id = p_actor_user_id
      AND tm.status::text = 'active'
      AND tm.role::text = 'capiro_admin'
  ) INTO v_is_admin;
  PERFORM set_config('app.bypass_rls', COALESCE(v_prior, ''), true);

  IF NOT v_is_admin THEN
    RAISE EXCEPTION 'active capiro_admin membership required'
      USING ERRCODE = '42501';
  END IF;
END;
$fn$;

COMMENT ON FUNCTION public.capiro_defense_require_admin(uuid, uuid) IS
  'Phase 8 Session 3: in-database capiro_admin recheck for governed Program graph mutations. Internal only - capiro_defense_serve cannot call it directly, and it is not a general membership oracle.';

REVOKE ALL ON FUNCTION public.capiro_defense_require_admin(uuid, uuid) FROM PUBLIC;
-- Not callable by the serve role: it is an internal helper for the mutation
-- functions below, never a probe an HTTP request can aim at a tenant.
REVOKE ALL ON FUNCTION public.capiro_defense_require_admin(uuid, uuid) FROM capiro_defense_serve;

-- ---------------------------------------------------------------------------
-- 2. Governed mutations.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.capiro_defense_resolve_program_match(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_match_id uuid,
  p_decision text,
  p_notes text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_match record;
  v_status text;
BEGIN
  PERFORM public.capiro_defense_require_admin(p_tenant_id, p_actor_user_id);
  IF p_decision NOT IN ('accept', 'reject', 'quarantine') THEN
    RAISE EXCEPTION 'decision must be accept, reject, or quarantine' USING ERRCODE = '22023';
  END IF;
  SELECT id, pe_code, project_code, program_id, score, evidence_tier, status
    INTO v_match
    FROM public.pe_program_match
    WHERE id = p_match_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PeProgramMatch % not found', p_match_id USING ERRCODE = 'P0002';
  END IF;
  v_status := CASE p_decision WHEN 'accept' THEN 'accepted' WHEN 'reject' THEN 'rejected' ELSE 'quarantined' END;
  -- Curated MDAP seeds are human-reviewed truth: reject them via the curation
  -- map, never the review queue.
  IF v_match.evidence_tier = 'mdap_curated' AND v_status <> 'accepted' THEN
    RAISE EXCEPTION 'Curated MDAP seed matches cannot be rejected/quarantined via the review queue; edit the curation map instead.' USING ERRCODE = '22023';
  END IF;
  UPDATE public.pe_program_match
     SET status = v_status,
         weak_signal = CASE WHEN v_status = 'accepted' THEN false ELSE weak_signal END,
         resolved_by_user_id = p_actor_user_id,
         resolved_at = now(),
         decision_notes = NULLIF(BTRIM(p_notes), '')
   WHERE id = p_match_id;
  INSERT INTO public.audit_logs
    (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, before_jsonb, after_jsonb, occurred_at)
  VALUES
    (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'capiro_admin', 'program.match.resolve',
     'pe_program_match', p_match_id::text,
     jsonb_build_object('status', v_match.status, 'score', v_match.score, 'evidenceTier', v_match.evidence_tier),
     jsonb_build_object('decision', p_decision, 'status', v_status, 'peCode', v_match.pe_code,
                        'projectCode', v_match.project_code, 'programId', v_match.program_id, 'notes', p_notes),
     now());
  RETURN jsonb_build_object('resolved', true, 'id', p_match_id, 'status', v_status, 'decision', p_decision);
END;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_resolve_program_match(uuid, uuid, uuid, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.capiro_defense_create_program_alias(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_program_id uuid,
  p_alias text,
  p_alias_normalized text,
  p_alias_type text,
  p_source text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_id uuid := gen_random_uuid();
  v_row jsonb;
BEGIN
  PERFORM public.capiro_defense_require_admin(p_tenant_id, p_actor_user_id);
  -- alias_normalized is computed by the caller with the SHARED normalizer
  -- (@capiro/defense-domain/pe-read), which is byte-identical to the matcher's,
  -- so an analyst alias always agrees with the pg_trgm index.
  INSERT INTO public.program_alias
    (id, program_id, alias, alias_normalized, alias_type, source, confidence, created_at, updated_at)
  VALUES
    (v_id, p_program_id, p_alias, p_alias_normalized, p_alias_type, p_source, 1, now(), now());
  SELECT to_jsonb(a) INTO v_row FROM public.program_alias a WHERE a.id = v_id;
  INSERT INTO public.audit_logs
    (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, after_jsonb, occurred_at)
  VALUES
    (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'capiro_admin', 'program.alias.create',
     'program_alias', v_id::text,
     jsonb_build_object('programId', p_program_id, 'alias', p_alias, 'aliasNormalized', p_alias_normalized,
                        'aliasType', p_alias_type, 'source', p_source), now());
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_create_program_alias(uuid, uuid, uuid, text, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.capiro_defense_update_program_alias(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_alias_id uuid,
  p_alias text,
  p_alias_normalized text,
  p_alias_type text
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_before record;
  v_row jsonb;
BEGIN
  PERFORM public.capiro_defense_require_admin(p_tenant_id, p_actor_user_id);
  SELECT * INTO v_before FROM public.program_alias WHERE id = p_alias_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ProgramAlias % not found', p_alias_id USING ERRCODE = 'P0002'; END IF;
  UPDATE public.program_alias
     SET alias = p_alias, alias_normalized = p_alias_normalized, alias_type = p_alias_type, updated_at = now()
   WHERE id = p_alias_id;
  SELECT to_jsonb(a) INTO v_row FROM public.program_alias a WHERE a.id = p_alias_id;
  INSERT INTO public.audit_logs
    (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, before_jsonb, after_jsonb, occurred_at)
  VALUES
    (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'capiro_admin', 'program.alias.update',
     'program_alias', p_alias_id::text,
     jsonb_build_object('alias', v_before.alias, 'aliasNormalized', v_before.alias_normalized, 'aliasType', v_before.alias_type),
     jsonb_build_object('alias', p_alias, 'aliasNormalized', p_alias_normalized, 'aliasType', p_alias_type), now());
  RETURN v_row;
END;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_update_program_alias(uuid, uuid, uuid, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.capiro_defense_delete_program_alias(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_alias_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_before record;
BEGIN
  PERFORM public.capiro_defense_require_admin(p_tenant_id, p_actor_user_id);
  SELECT * INTO v_before FROM public.program_alias WHERE id = p_alias_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ProgramAlias % not found', p_alias_id USING ERRCODE = 'P0002'; END IF;
  -- Deleting a program's last canonical alias would orphan its primary name.
  IF v_before.alias_type = 'canonical' AND NOT EXISTS (
    SELECT 1 FROM public.program_alias a
    WHERE a.program_id = v_before.program_id AND a.alias_type = 'canonical' AND a.id <> p_alias_id
  ) THEN
    RAISE EXCEPTION 'Refusing to delete a program''s last ''canonical'' alias (it would orphan the program).' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.program_alias WHERE id = p_alias_id;
  INSERT INTO public.audit_logs
    (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, before_jsonb, occurred_at)
  VALUES
    (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'capiro_admin', 'program.alias.delete',
     'program_alias', p_alias_id::text,
     jsonb_build_object('programId', v_before.program_id, 'alias', v_before.alias,
                        'aliasNormalized', v_before.alias_normalized, 'aliasType', v_before.alias_type), now());
  RETURN jsonb_build_object('deleted', true, 'id', p_alias_id);
END;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_delete_program_alias(uuid, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.capiro_defense_merge_programs(
  p_tenant_id uuid,
  p_actor_user_id uuid,
  p_keep_program_id uuid,
  p_merge_program_id uuid
) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = ''
AS $fn$
DECLARE
  v_keep record;
  v_loser record;
  v_matches_deleted int := 0;
  v_matches_repointed int := 0;
  v_roles_repointed int := 0;
  v_office_deleted int := 0;
  v_office_repointed int := 0;
  v_provision_deleted int := 0;
  v_provision_repointed int := 0;
  v_aliases_copied int := 0;
  v_merged_at timestamptz := now();
  v_metadata jsonb;
  v_result jsonb;
BEGIN
  PERFORM public.capiro_defense_require_admin(p_tenant_id, p_actor_user_id);
  IF p_keep_program_id = p_merge_program_id THEN
    RAISE EXCEPTION 'keepProgramId and mergeProgramId must differ.' USING ERRCODE = '22023';
  END IF;
  SELECT id, canonical_name, status, metadata_jsonb INTO v_keep
    FROM public.program WHERE id = p_keep_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'keep Program % not found', p_keep_program_id USING ERRCODE = 'P0002'; END IF;
  SELECT id, canonical_name, status, metadata_jsonb INTO v_loser
    FROM public.program WHERE id = p_merge_program_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'merge Program % not found', p_merge_program_id USING ERRCODE = 'P0002'; END IF;
  IF v_loser.status = 'merged' THEN
    RAISE EXCEPTION 'Program % is already merged.', p_merge_program_id USING ERRCODE = '22023';
  END IF;

  -- Each FK table that references the losing program must be re-pointed, or the
  -- merged program's matches, people, offices and committee report language
  -- silently vanish from every view that joins through them. Where a uniqueness
  -- constraint involves program_id, a loser row whose re-pointed key already
  -- exists on the keeper is DELETED first, then the remainder is bulk-moved.

  -- pe_program_match: unique on (pe_code, coalesce(project_code,''), program_id)
  WITH removed AS (
    DELETE FROM public.pe_program_match loser
    WHERE loser.program_id = p_merge_program_id
      AND EXISTS (
        SELECT 1 FROM public.pe_program_match keeper
        WHERE keeper.program_id = p_keep_program_id
          AND keeper.pe_code = loser.pe_code
          AND COALESCE(keeper.project_code, '') = COALESCE(loser.project_code, '')
      ) RETURNING 1
  ) SELECT COUNT(*)::int INTO v_matches_deleted FROM removed;
  WITH moved AS (
    UPDATE public.pe_program_match SET program_id = p_keep_program_id
    WHERE program_id = p_merge_program_id RETURNING 1
  ) SELECT COUNT(*)::int INTO v_matches_repointed FROM moved;

  -- person_role: no unique on program_id -> straight re-point.
  WITH moved AS (
    UPDATE public.person_role SET program_id = p_keep_program_id
    WHERE program_id = p_merge_program_id RETURNING 1
  ) SELECT COUNT(*)::int INTO v_roles_repointed FROM moved;

  -- program_office_program_link: unique on (office_id, program_id)
  WITH removed AS (
    DELETE FROM public.program_office_program_link loser
    WHERE loser.program_id = p_merge_program_id
      AND EXISTS (
        SELECT 1 FROM public.program_office_program_link keeper
        WHERE keeper.program_id = p_keep_program_id AND keeper.office_id = loser.office_id
      ) RETURNING 1
  ) SELECT COUNT(*)::int INTO v_office_deleted FROM removed;
  WITH moved AS (
    UPDATE public.program_office_program_link SET program_id = p_keep_program_id
    WHERE program_id = p_merge_program_id RETURNING 1
  ) SELECT COUNT(*)::int INTO v_office_repointed FROM moved;

  -- provision_pe_link: unique on (provision_id, coalesce(pe_code,''), program_id)
  WITH removed AS (
    DELETE FROM public.provision_pe_link loser
    WHERE loser.program_id = p_merge_program_id
      AND EXISTS (
        SELECT 1 FROM public.provision_pe_link keeper
        WHERE keeper.program_id = p_keep_program_id
          AND keeper.provision_id = loser.provision_id
          AND COALESCE(keeper.pe_code, '') = COALESCE(loser.pe_code, '')
      ) RETURNING 1
  ) SELECT COUNT(*)::int INTO v_provision_deleted FROM removed;
  WITH moved AS (
    UPDATE public.provision_pe_link SET program_id = p_keep_program_id
    WHERE program_id = p_merge_program_id RETURNING 1
  ) SELECT COUNT(*)::int INTO v_provision_repointed FROM moved;

  -- program_alias: move only the aliases the keeper does NOT already hold. A
  -- colliding alias deliberately STAYS with the retired loser -- that is
  -- apps/api's behaviour (`continue`, not delete): the keeper already carries an
  -- equivalent alias, the loser row is retired, and nothing is destroyed.
  WITH moved AS (
    UPDATE public.program_alias loser
       SET program_id = p_keep_program_id, updated_at = now()
     WHERE loser.program_id = p_merge_program_id
       AND NOT EXISTS (
         SELECT 1 FROM public.program_alias keeper
         WHERE keeper.program_id = p_keep_program_id
           AND keeper.alias_normalized = loser.alias_normalized
           AND keeper.alias_type = loser.alias_type
       ) RETURNING 1
  ) SELECT COUNT(*)::int INTO v_aliases_copied FROM moved;

  -- Retire the loser; never hard-delete it. A delete is permanent history loss
  -- and risks dangling references from rows the curated schema does not model.
  v_metadata := COALESCE(v_loser.metadata_jsonb, '{}'::jsonb)
    || jsonb_build_object('mergedInto', p_keep_program_id, 'mergedAt', to_char(v_merged_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  UPDATE public.program
     SET status = 'merged', metadata_jsonb = v_metadata, updated_at = v_merged_at
   WHERE id = p_merge_program_id;

  v_result := jsonb_build_object(
    'merged', true,
    'keepProgramId', p_keep_program_id,
    'mergeProgramId', p_merge_program_id,
    'repointed', jsonb_build_object(
      'matches', v_matches_repointed,
      'roles', v_roles_repointed,
      'officeLinks', v_office_repointed,
      'provisionLinks', v_provision_repointed
    ),
    'aliasesCopied', v_aliases_copied
  );
  INSERT INTO public.audit_logs
    (id, tenant_id, actor_user_id, actor_role, action, entity_type, entity_id, before_jsonb, after_jsonb, occurred_at)
  VALUES
    (gen_random_uuid(), p_tenant_id, p_actor_user_id, 'capiro_admin', 'program.merge',
     'program', p_merge_program_id::text,
     jsonb_build_object('mergeProgramId', p_merge_program_id, 'mergeCanonicalName', v_loser.canonical_name, 'mergeStatus', v_loser.status),
     jsonb_build_object('keepProgramId', p_keep_program_id, 'keepCanonicalName', v_keep.canonical_name,
       'status', 'merged', 'mergedInto', p_keep_program_id, 'mergedAt', v_merged_at,
       'repointed', v_result->'repointed',
       'deleted', jsonb_build_object('matches', v_matches_deleted, 'officeLinks', v_office_deleted, 'provisionLinks', v_provision_deleted),
       'aliasesCopied', v_aliases_copied),
     now());
  RETURN v_result;
END;
$fn$;

REVOKE ALL ON FUNCTION public.capiro_defense_merge_programs(uuid, uuid, uuid, uuid) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Collapse the serve role to SELECT-only on the global Program graph, and
--    grant EXECUTE on the governed mutations to that role alone.
-- ---------------------------------------------------------------------------
-- The tenant-scoped OVERLAY tables (program_element_watch,
-- program_element_data_issue, pe_alert_email_pref, reconciliation_review_queue)
-- keep their DML: they carry tenant_id + RLS, so a write there is already
-- confined to the caller's own tenant. defense_budget_manual_override likewise
-- keeps INSERT/UPDATE (never DELETE) because the Phase 7 overlay service
-- enforces immutable content, exact-money hashing and two-person approval.
DO $graph_lockdown$
DECLARE
  relation_name text;
  global_graph_relations text[] := ARRAY[
    'program',
    'program_alias',
    'pe_program_match',
    'person_role',
    'program_office_program_link',
    'provision_pe_link'
  ];
BEGIN
  FOREACH relation_name IN ARRAY global_graph_relations LOOP
    IF to_regclass(format('public.%I', relation_name)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM capiro_defense_serve', relation_name);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO capiro_defense_serve', relation_name);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_resolve_program_match(uuid, uuid, uuid, text, text) TO capiro_defense_serve';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_create_program_alias(uuid, uuid, uuid, text, text, text, text) TO capiro_defense_serve';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_update_program_alias(uuid, uuid, uuid, text, text, text) TO capiro_defense_serve';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_delete_program_alias(uuid, uuid, uuid) TO capiro_defense_serve';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.capiro_defense_merge_programs(uuid, uuid, uuid, uuid) TO capiro_defense_serve';
  END IF;

  -- The job/ingestion plane has no business performing an operator's governed
  -- graph decision, and the parser plane has no database role at all.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_resolve_program_match(uuid, uuid, uuid, text, text) FROM capiro_defense_job';
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_create_program_alias(uuid, uuid, uuid, text, text, text, text) FROM capiro_defense_job';
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_update_program_alias(uuid, uuid, uuid, text, text, text) FROM capiro_defense_job';
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_delete_program_alias(uuid, uuid, uuid) FROM capiro_defense_job';
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_merge_programs(uuid, uuid, uuid, uuid) FROM capiro_defense_job';
    EXECUTE 'REVOKE ALL ON FUNCTION public.capiro_defense_require_admin(uuid, uuid) FROM capiro_defense_job';
  END IF;
END
$graph_lockdown$;
