-- MeriV2 closeout Phase 4 — immutable reviewed corrections and restores.
-- Additive guards only. This migration is NOT executed by this branch/task.

-- Version candidates carry a typed payload that names the immutable source row.
-- The source_kind values fit the existing varchar(24) contract.
DO $$ BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_version_payload_check CHECK (
      source_kind NOT IN ('memory_correction','memory_restore','memory_contradiction')
      OR (
        jsonb_typeof(payload_jsonb->'versionProposal') = 'object'
        AND payload_jsonb #>> '{versionProposal,kind}' IN ('correction','restore','contradiction')
        AND payload_jsonb #>> '{versionProposal,sourceItemId}'
          ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (
          payload_jsonb #>> '{versionProposal,targetItemId}' IS NULL
          OR payload_jsonb #>> '{versionProposal,targetItemId}'
            ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
        AND (
          (source_kind = 'memory_correction'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'correction')
          OR (source_kind = 'memory_restore'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'restore')
          OR (source_kind = 'memory_contradiction'
            AND payload_jsonb #>> '{versionProposal,kind}' = 'contradiction')
        )
      )
    ) NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_version_payload_check;

-- Every immutable version insert is bound to the exact target that was reviewed.
-- The trigger also prevents resolved losers/open conflict members from being treated
-- as controlling truth, carries legal holds forward to derivative versions, and
-- prevents an expired restore from becoming an immediately invisible "active" row.
CREATE OR REPLACE FUNCTION guard_immutable_memory_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_memory memory_items%ROWTYPE;
  target_memory memory_items%ROWTYPE;
  reviewed_target_id uuid;
  expected_target_id uuid;
  actual_target_id uuid;
BEGIN
  IF NEW.origin_surface NOT IN ('memory_correction','memory_restore','memory_contradiction') THEN
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
$$;

DROP TRIGGER IF EXISTS memory_items_immutable_version_insert_guard ON memory_items;
CREATE TRIGGER memory_items_immutable_version_insert_guard
BEFORE INSERT ON memory_items
FOR EACH ROW
EXECUTE FUNCTION guard_immutable_memory_version_insert();

-- Generic MemoryCandidateService approval uses an upsert-shaped canonical write.
-- That is valid for a normal save, but forbidden for correction/restore candidates.
-- Only ImmutableMemoryVersionService may set this transaction-local capability
-- after it has locked the rows and completed server-owned authorization.
CREATE OR REPLACE FUNCTION guard_memory_version_candidate_activation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

DROP TRIGGER IF EXISTS memory_candidate_version_activation_guard ON memory_candidate;
CREATE TRIGGER memory_candidate_version_activation_guard
BEFORE UPDATE OF status ON memory_candidate
FOR EACH ROW
EXECUTE FUNCTION guard_memory_version_candidate_activation();

-- Legal hold is a database boundary, not merely a button state. A held row may be
-- read, confirmed, or used as a historical source for a nondestructive restore,
-- but no code path may revoke or supersede that exact row.
CREATE OR REPLACE FUNCTION guard_held_memory_terminal_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
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
$$;

DROP TRIGGER IF EXISTS memory_items_legal_hold_transition_guard ON memory_items;
CREATE TRIGGER memory_items_legal_hold_transition_guard
BEFORE UPDATE OF status, governed_status ON memory_items
FOR EACH ROW
EXECUTE FUNCTION guard_held_memory_terminal_transition();

-- A resolved loser or unresolved conflict member is retained history, not current
-- truth. No future direct update path may supersede it as though it controlled scope.
CREATE OR REPLACE FUNCTION guard_noncontrolling_memory_supersession()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.status IS DISTINCT FROM OLD.status AND NEW.status = 'superseded'
    OR NEW.governed_status IS DISTINCT FROM OLD.governed_status
      AND NEW.governed_status = 'superseded'
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
$$;

DROP TRIGGER IF EXISTS memory_items_controlling_supersession_guard ON memory_items;
CREATE TRIGGER memory_items_controlling_supersession_guard
BEFORE UPDATE OF status, governed_status ON memory_items
FOR EACH ROW
EXECUTE FUNCTION guard_noncontrolling_memory_supersession();
