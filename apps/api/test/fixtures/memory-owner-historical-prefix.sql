-- Historical pre-0500 trigger prefix on the tables the memory owner retention
-- migration extends. Definitions are copied verbatim from the read-only cluster
-- probe (work/read-only-footprint-02/catalog/trigger-and-proconfig-probe.json,
-- 2026-10-29T22:58:58Z, body_md5 recorded there). This is a bounded compatibility
-- fixture: it proves 0500 coexists with the real guard functions and their
-- name-ordered firing, not that a full 522-file catalog replay was performed.

-- check_client_ordered_owners | observed owner capiro_master | secdef false | proconfig null | body_md5 e93fbb056c51ba32c4546f34c25de54c
CREATE OR REPLACE FUNCTION public.check_client_ordered_owners()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_tenant uuid;
  target_client uuid;
  projected uuid;
  primary_owner uuid;
  owner_count integer;
  last_rank integer;
BEGIN
  IF TG_TABLE_NAME='client_ordered_owners' AND TG_OP='UPDATE' THEN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR OLD.client_id IS DISTINCT FROM NEW.client_id THEN
      RAISE EXCEPTION 'Owner assignment parent is immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_TABLE_NAME='clients' THEN
    target_tenant := NEW.tenant_id;
    target_client := NEW.id;
  ELSIF TG_OP='DELETE' THEN
    target_tenant := OLD.tenant_id;
    target_client := OLD.client_id;
  ELSE
    target_tenant := NEW.tenant_id;
    target_client := NEW.client_id;
  END IF;
  SELECT account_owner_user_id INTO projected FROM clients
    WHERE tenant_id=target_tenant AND id=target_client;
  IF NOT FOUND THEN RETURN NULL; END IF; -- Client deletion cascades the set.
  SELECT count(*),max(rank) INTO owner_count,last_rank FROM client_ordered_owners
    WHERE tenant_id=target_tenant AND client_id=target_client;
  SELECT user_id INTO primary_owner FROM client_ordered_owners
    WHERE tenant_id=target_tenant AND client_id=target_client AND rank=1;
  IF (owner_count>0 AND owner_count<>last_rank) OR projected IS DISTINCT FROM primary_owner THEN
    RAISE EXCEPTION 'Ordered account owners and Primary must agree' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $function$;

-- enforce_memory_review_assignment_on_decision | observed owner capiro_master | secdef false | proconfig "{\"search_path=public, pg_temp\"}" | body_md5 7ff654ea0929587a93ae3be3b4cd8914
CREATE OR REPLACE FUNCTION public.enforce_memory_review_assignment_on_decision()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  workflow_requested_by uuid;
  workflow_assigned_to uuid;
  workflow_status text;
  workflow_assignment_enforced boolean;
  actor_is_active_admin boolean;
  capability_candidate_id text;
  capability_actor_id text;
  admin_decision_capability boolean;
BEGIN
  IF OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected')
     AND OLD.scope IN ('firm', 'client') THEN
    SELECT requested_by,
           assigned_to,
           status,
           COALESCE((payload_jsonb->>'assignmentEnforced')::boolean, false)
      INTO workflow_requested_by,
           workflow_assigned_to,
           workflow_status,
           workflow_assignment_enforced
    FROM review_request
    WHERE tenant_id = NEW.tenant_id
      AND surface = 'memory'
      AND subject_type = 'memory_candidate'
      AND subject_id = NEW.id::text
    FOR UPDATE;

    IF NOT FOUND OR NOT workflow_assignment_enforced THEN
      RETURN NEW;
    END IF;
    IF workflow_status <> 'pending' THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_NOT_PENDING'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by IS NULL THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_DECIDER_REQUIRED'
        USING ERRCODE = '42501';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM tenant_memberships tm
      WHERE tm.tenant_id = NEW.tenant_id
        AND tm.user_id = NEW.decided_by
        AND tm.status = 'active'::membership_status
        AND tm.role IN ('user_admin'::tenant_role, 'capiro_admin'::tenant_role)
    ) INTO actor_is_active_admin;

    capability_candidate_id :=
      current_setting('app.memory_admin_review_candidate_id', true);
    capability_actor_id :=
      current_setting('app.memory_admin_review_actor_id', true);
    admin_decision_capability :=
      capability_candidate_id = NEW.id::text
      AND capability_actor_id = NEW.decided_by::text;

    -- Active administrators may decide this exact review they were authorized
    -- to see, including their own proposal, only through the canonical
    -- candidate-and-actor-bound application transaction.
    IF actor_is_active_admin AND admin_decision_capability THEN
      RETURN NEW;
    END IF;

    -- Preserve the existing route-containment boundary for every direct or
    -- non-admin decision path.
    IF workflow_assigned_to IS NULL
       OR NEW.decided_by <> workflow_assigned_to THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_ASSIGNED_REVIEWER_REQUIRED'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.decided_by = workflow_requested_by THEN
      RAISE EXCEPTION 'MEMORY_REVIEW_SELF_DECISION_DENIED'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ensure_memory_review_request_for_candidate | observed owner capiro_master | secdef false | proconfig "{\"search_path=public, pg_temp\"}" | body_md5 d4f8be15e972787859756fe09097e57b
CREATE OR REPLACE FUNCTION public.ensure_memory_review_request_for_candidate()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'pending' AND NEW.scope IN ('firm', 'client') THEN
    INSERT INTO review_request (
      tenant_id,
      risk_tier,
      surface,
      subject_type,
      subject_id,
      client_id,
      title,
      reason,
      payload_jsonb,
      status,
      requested_by,
      assigned_to,
      created_at
    ) VALUES (
      NEW.tenant_id,
      'moderate',
      'memory',
      'memory_candidate',
      NEW.id::text,
      NEW.client_id,
      memory_review_workflow_title(NEW.payload_jsonb),
      'Memory candidate awaiting administrator review.',
      memory_review_workflow_metadata(NEW.source_kind, NEW.scope, false),
      'pending',
      NEW.proposed_by,
      NULL,
      NEW.created_at
    )
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

-- guard_held_memory_terminal_transition | observed owner capiro_master | secdef false | proconfig null | body_md5 694c749ad080b91d65c898eeecebe15a
CREATE OR REPLACE FUNCTION public.guard_held_memory_terminal_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.legal_hold = true
     AND (
       (NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('revoked','superseded'))
       OR (
         NEW.governed_status IS DISTINCT FROM OLD.governed_status
         AND NEW.governed_status IN ('revoked','superseded','expired')
       )
     )
  THEN
    RAISE EXCEPTION 'legal-held memory cannot be destructively transitioned'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

-- guard_immutable_memory_version_insert | observed owner capiro_master | secdef false | proconfig null | body_md5 c97ded14977b1eba2fd890cabd04d699
CREATE OR REPLACE FUNCTION public.guard_immutable_memory_version_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  source_memory memory_items%ROWTYPE;
  target_memory memory_items%ROWTYPE;
  reviewed_target_id uuid;
  expected_target_id uuid;
  actual_target_id uuid;
BEGIN
  IF NEW.origin_surface IS NULL
     OR NEW.origin_surface NOT IN ('memory_correction','memory_restore','memory_contradiction')
  THEN
    RETURN NEW;
  END IF;

  IF NEW.source_type <> 'approved_document_edit'
     OR NEW.source_id IS NULL
     OR NEW.source_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    RAISE EXCEPTION 'immutable memory version requires a valid historical source item'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO source_memory
  FROM memory_items
  WHERE id = NEW.source_id::uuid AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'immutable memory version source item does not exist in this tenant'
      USING ERRCODE = '55000';
  END IF;

  -- A derivative of held evidence remains held. Creating a new row must never be a
  -- route around the existing row's terminal-transition guard.
  IF source_memory.legal_hold THEN
    NEW.legal_hold := true;
  END IF;

  actual_target_id := CASE
    WHEN NEW.origin_surface = 'memory_contradiction' THEN NEW.contradicts_id
    ELSE NEW.supersedes_id
  END;
  IF actual_target_id IS NULL THEN
    RAISE EXCEPTION 'immutable memory version is missing its reviewed target lineage'
      USING ERRCODE = '55000';
  END IF;

  -- Shared proposals persist the target visible to the proposer. Do not let a later
  -- approval silently retarget a restore/correction after controlling truth changed.
  IF NEW.origin_trace_id IS NOT NULL
     AND NEW.origin_trace_id
       ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    SELECT NULLIF(payload_jsonb #>> '{versionProposal,targetItemId}', '')::uuid
      INTO reviewed_target_id
    FROM memory_candidate
    WHERE id = NEW.origin_trace_id::uuid AND tenant_id = NEW.tenant_id
      AND source_kind = NEW.origin_surface;
    IF FOUND THEN
      expected_target_id := COALESCE(reviewed_target_id, source_memory.id);
      IF actual_target_id IS DISTINCT FROM expected_target_id THEN
        RAISE EXCEPTION 'memory version approval target drifted from reviewed proposal'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  -- A restore with no active descendant legitimately points at its terminal source.
  -- Every other correction/restore/contradiction must target the current controlling
  -- row—not an unresolved conflict member or a resolved losing version.
  IF NOT (
    NEW.origin_surface = 'memory_restore'
    AND actual_target_id = source_memory.id
    AND (
      source_memory.status IN ('revoked','superseded')
      OR source_memory.governed_status IN ('revoked','superseded','rejected','expired')
    )
  ) THEN
    SELECT * INTO target_memory
    FROM memory_items
    WHERE id = actual_target_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR NOT (
      target_memory.status = 'active'
      AND (
        (target_memory.governed_status IN ('active','stale')
          AND target_memory.conflict_status = 'none')
        OR (target_memory.governed_status = 'conflicted'
          AND target_memory.conflict_status = 'controlling'
          AND target_memory.controlling_item_id = target_memory.id)
      )
    ) THEN
      RAISE EXCEPTION 'memory version target is not the controlling version'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW.origin_surface = 'memory_restore' THEN
    IF NEW.valid_until IS NOT NULL AND NEW.valid_until <= now() THEN
      NEW.valid_until := NULL;
    END IF;
    IF NEW.expires_at IS NOT NULL AND NEW.expires_at <= now() THEN
      IF NEW.memory_class = 'episodic_working' THEN
        RAISE EXCEPTION 'expired working-memory restore requires a new TTL'
          USING ERRCODE = '55000';
      END IF;
      NEW.expires_at := NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- guard_memory_version_candidate_activation | observed owner capiro_master | secdef false | proconfig null | body_md5 eb2adf8bd7402904c79ae68eb6fba36a
CREATE OR REPLACE FUNCTION public.guard_memory_version_candidate_activation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  reviewed_source_id uuid;
  reviewed_target_id uuid;
  expected_target_id uuid;
  actual_target_id uuid;
  committed_parent_id uuid;
  committed_contradicts_id uuid;
  committed_conflict_group_id uuid;
BEGIN
  IF OLD.status = 'pending'
     AND NEW.status IN ('approved','auto_committed')
     AND OLD.source_kind IN ('memory_correction','memory_restore','memory_contradiction')
  THEN
    IF current_setting('app.memory_version_activation', true) IS DISTINCT FROM 'on' THEN
      RAISE EXCEPTION 'memory version candidates require immutable activation service'
        USING ERRCODE = '55000';
    END IF;

    reviewed_source_id := (OLD.payload_jsonb #>> '{versionProposal,sourceItemId}')::uuid;
    reviewed_target_id := NULLIF(
      OLD.payload_jsonb #>> '{versionProposal,targetItemId}', ''
    )::uuid;
    expected_target_id := COALESCE(reviewed_target_id, reviewed_source_id);

    IF NEW.committed_memory_item_id IS NULL THEN
      RAISE EXCEPTION 'approved memory version candidate has no committed item lineage'
        USING ERRCODE = '55000';
    END IF;

    IF NEW.duplicate_memory_item_id IS NOT NULL THEN
      actual_target_id := NEW.duplicate_memory_item_id;
      IF NEW.committed_memory_item_id IS DISTINCT FROM NEW.duplicate_memory_item_id THEN
        RAISE EXCEPTION 'duplicate memory version candidate committed inconsistent lineage'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT supersedes_id, contradicts_id, conflict_group_id
        INTO committed_parent_id, committed_contradicts_id, committed_conflict_group_id
      FROM memory_items
      WHERE id = NEW.committed_memory_item_id AND tenant_id = OLD.tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'approved memory version candidate references a missing committed item'
          USING ERRCODE = '55000';
      END IF;
      actual_target_id := CASE
        WHEN OLD.source_kind = 'memory_contradiction' THEN committed_contradicts_id
        ELSE committed_parent_id
      END;
    END IF;

    IF actual_target_id IS DISTINCT FROM expected_target_id THEN
      RAISE EXCEPTION 'memory version approval target drifted from reviewed proposal'
        USING ERRCODE = '55000';
    END IF;

    -- A contradiction that normalized to an exact duplicate is not an open conflict.
    -- A real contradiction must carry the same group as its committed memory item.
    IF OLD.source_kind = 'memory_contradiction'
       AND NEW.duplicate_memory_item_id IS NULL
    THEN
      IF committed_conflict_group_id IS NULL THEN
        RAISE EXCEPTION 'approved contradiction has no conflict group'
          USING ERRCODE = '55000';
      END IF;
      NEW.conflict_status := 'open';
      NEW.conflict_group_id := committed_conflict_group_id;
      NEW.controlling_item_id := NULL;
    ELSE
      NEW.conflict_status := 'none';
      NEW.conflict_group_id := NULL;
      NEW.controlling_item_id := NEW.committed_memory_item_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- guard_noncontrolling_memory_supersession | observed owner capiro_master | secdef false | proconfig null | body_md5 47987527e05dbc59b1e52fc1d789e285
CREATE OR REPLACE FUNCTION public.guard_noncontrolling_memory_supersession()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF (
    (NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'superseded')
    OR (
      NEW.governed_status IS DISTINCT FROM OLD.governed_status
      AND NEW.governed_status = 'superseded'
    )
  )
  AND OLD.governed_status = 'conflicted'
  AND NOT (
    OLD.conflict_status = 'controlling'
    AND OLD.controlling_item_id = OLD.id
  )
  THEN
    RAISE EXCEPTION 'noncontrolling conflict memory cannot be superseded'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;

-- set_updated_at | observed owner capiro_master | secdef false | proconfig null | body_md5 da5ac28a58c8b4bb30209bf0d3d7082c
CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$function$;

-- sync_memory_review_request_terminal_status | observed owner capiro_master | secdef false | proconfig "{\"search_path=public, pg_temp\"}" | body_md5 561b3f8e439dc75664473dd621f00f4b
CREATE OR REPLACE FUNCTION public.sync_memory_review_request_terminal_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NEW.status IN ('approved', 'rejected', 'withdrawn') THEN
    UPDATE review_request
    SET status = NEW.status,
        decided_by = NEW.decided_by,
        decided_at = COALESCE(NEW.decided_at, now())
    WHERE tenant_id = NEW.tenant_id
      AND surface = 'memory'
      AND subject_type = 'memory_candidate'
      AND subject_id = NEW.id::text;
  END IF;
  RETURN NEW;
END;
$function$;

-- Trigger definitions (names, timing, events) exactly as observed. Firing
-- order within one timing is by trigger name.
-- clients.clients_ordered_owners_consistent tgtype 21
CREATE CONSTRAINT TRIGGER clients_ordered_owners_consistent AFTER INSERT OR UPDATE ON public.clients DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_client_ordered_owners();

-- clients.clients_set_updated_at tgtype 19
CREATE TRIGGER clients_set_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- memory_candidate.memory_candidate_enforce_review_assignment tgtype 19
CREATE TRIGGER memory_candidate_enforce_review_assignment BEFORE UPDATE OF status, decided_by ON public.memory_candidate FOR EACH ROW EXECUTE FUNCTION enforce_memory_review_assignment_on_decision();

-- memory_candidate.memory_candidate_ensure_review_request tgtype 5
CREATE TRIGGER memory_candidate_ensure_review_request AFTER INSERT ON public.memory_candidate FOR EACH ROW EXECUTE FUNCTION ensure_memory_review_request_for_candidate();

-- memory_candidate.memory_candidate_sync_review_terminal tgtype 17
CREATE TRIGGER memory_candidate_sync_review_terminal AFTER UPDATE OF status, decided_by, decided_at ON public.memory_candidate FOR EACH ROW EXECUTE FUNCTION sync_memory_review_request_terminal_status();

-- memory_candidate.memory_candidate_version_activation_guard tgtype 19
CREATE TRIGGER memory_candidate_version_activation_guard BEFORE UPDATE OF status ON public.memory_candidate FOR EACH ROW EXECUTE FUNCTION guard_memory_version_candidate_activation();

-- memory_items.memory_items_controlling_supersession_guard tgtype 19
CREATE TRIGGER memory_items_controlling_supersession_guard BEFORE UPDATE OF status, governed_status ON public.memory_items FOR EACH ROW EXECUTE FUNCTION guard_noncontrolling_memory_supersession();

-- memory_items.memory_items_immutable_version_insert_guard tgtype 7
CREATE TRIGGER memory_items_immutable_version_insert_guard BEFORE INSERT ON public.memory_items FOR EACH ROW EXECUTE FUNCTION guard_immutable_memory_version_insert();

-- memory_items.memory_items_legal_hold_transition_guard tgtype 19
CREATE TRIGGER memory_items_legal_hold_transition_guard BEFORE UPDATE OF status, governed_status ON public.memory_items FOR EACH ROW EXECUTE FUNCTION guard_held_memory_terminal_transition();

-- tenant_memberships.tenant_memberships_set_updated_at tgtype 19
CREATE TRIGGER tenant_memberships_set_updated_at BEFORE UPDATE ON public.tenant_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
