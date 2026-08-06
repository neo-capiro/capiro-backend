-- Phase 2 increment 2: immutable candidate revision and resubmission lineage.
-- Existing candidates remain revision 1. Revised candidates receive explicit
-- root/predecessor/revision metadata, and exactly one successor may derive from
-- a predecessor. The clone function runs lineage creation, predecessor
-- supersession, and successor workflow creation in one transaction.
--
-- SQL-OWNED LINEAGE CONTRACT
-- The four additive lineage columns remain intentionally absent from Prisma's
-- MemoryCandidate model during Phase 2. The application reads/writes them only
-- through locked raw SQL and create_memory_candidate_revision. This prevents a
-- generated Prisma delegate from offering unsafe partial lineage mutations while
-- Prisma safely ignores additive database columns during validate/generate.

ALTER TABLE memory_candidate
  ADD COLUMN IF NOT EXISTS revision_root_id uuid,
  ADD COLUMN IF NOT EXISTS predecessor_candidate_id uuid,
  ADD COLUMN IF NOT EXISTS revision_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS superseded_by_id uuid;

-- Self-referential lineage must remain in the same tenant even under direct SQL.
-- `id` is globally unique, but UUID-only foreign keys do not encode the tenant
-- boundary. This non-partial unique index lets every lineage FK bind the owning
-- tenant and candidate identity together.
CREATE UNIQUE INDEX IF NOT EXISTS memory_candidate_tenant_id_id_unique
  ON memory_candidate (tenant_id, id);

DO $$
BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_revision_root_fk
    FOREIGN KEY (tenant_id, revision_root_id)
    REFERENCES memory_candidate(tenant_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_predecessor_fk
    FOREIGN KEY (tenant_id, predecessor_candidate_id)
    REFERENCES memory_candidate(tenant_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_superseded_by_fk
    FOREIGN KEY (tenant_id, superseded_by_id)
    REFERENCES memory_candidate(tenant_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE memory_candidate
    ADD CONSTRAINT memory_candidate_revision_shape_check
    CHECK (
      revision_number >= 1
      AND (
        predecessor_candidate_id IS NULL
        OR (
          revision_root_id IS NOT NULL
          AND revision_number > 1
          AND predecessor_candidate_id <> id
          AND revision_root_id <> id
        )
      )
      AND (superseded_by_id IS NULL OR superseded_by_id <> id)
    ) NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_revision_root_fk;
ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_predecessor_fk;
ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_superseded_by_fk;
ALTER TABLE memory_candidate
  VALIDATE CONSTRAINT memory_candidate_revision_shape_check;

CREATE UNIQUE INDEX IF NOT EXISTS memory_candidate_one_successor_per_predecessor
  ON memory_candidate (tenant_id, predecessor_candidate_id)
  WHERE predecessor_candidate_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS memory_candidate_root_revision_unique
  ON memory_candidate (tenant_id, revision_root_id, revision_number)
  WHERE revision_root_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS memory_candidate_revision_root_idx
  ON memory_candidate (tenant_id, revision_root_id, revision_number DESC)
  WHERE revision_root_id IS NOT NULL;

-- Clone the complete predecessor row rather than rebuilding a partial candidate
-- from browser input. Only immutable-content payload/provenance, lifecycle
-- stamps, revision-owned source identity, and lineage fields are replaced. This
-- preserves versionProposal, canonical identity, memory class/scope, client
-- boundary, and source evidence without carrying a stale content hash/version.
--
-- The application database role bypasses PostgreSQL RLS (tenant isolation is
-- normally enforced by PrismaService's scoped client). Therefore this function
-- independently binds its tenant and proposer arguments to the transaction-local
-- GUCs set by withTenantUser and explicitly rejects system-bypass execution.
CREATE OR REPLACE FUNCTION create_memory_candidate_revision(
  p_tenant_id uuid,
  p_predecessor_id uuid,
  p_proposer_id uuid,
  p_successor_id uuid,
  p_payload jsonb,
  p_provenance jsonb,
  p_source_content_hash text
)
RETURNS TABLE (
  candidate_id uuid,
  root_candidate_id uuid,
  candidate_revision_number integer
)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  predecessor memory_candidate%ROWTYPE;
  workflow review_request%ROWTYPE;
  root_id uuid;
  next_revision integer;
  superseded_at timestamptz;
  tenant_context text;
  actor_context text;
  bypass_context text;
BEGIN
  tenant_context := NULLIF(current_setting('app.current_tenant', true), '');
  actor_context := NULLIF(current_setting('app.current_user', true), '');
  bypass_context := lower(COALESCE(current_setting('app.bypass_rls', true), ''));

  IF bypass_context IN ('on', 'true', '1') THEN
    RAISE EXCEPTION 'MEMORY_REVISION_SYSTEM_BYPASS_DENIED'
      USING ERRCODE = '42501';
  END IF;
  IF tenant_context IS NULL
     OR tenant_context !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR tenant_context::uuid <> p_tenant_id THEN
    RAISE EXCEPTION 'MEMORY_REVISION_TENANT_CONTEXT_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF actor_context IS NULL
     OR actor_context !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR actor_context::uuid <> p_proposer_id THEN
    RAISE EXCEPTION 'MEMORY_REVISION_ACTOR_CONTEXT_REQUIRED'
      USING ERRCODE = '42501';
  END IF;
  IF p_successor_id = p_predecessor_id THEN
    RAISE EXCEPTION 'MEMORY_REVISION_SUCCESSOR_ID_REQUIRED'
      USING ERRCODE = '22023';
  END IF;
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'MEMORY_REVISION_PAYLOAD_REQUIRED'
      USING ERRCODE = '22023';
  END IF;
  IF p_provenance IS NULL OR jsonb_typeof(p_provenance) <> 'object' THEN
    RAISE EXCEPTION 'MEMORY_REVISION_PROVENANCE_REQUIRED'
      USING ERRCODE = '22023';
  END IF;
  IF p_source_content_hash IS NULL
     OR p_source_content_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'MEMORY_REVISION_CONTENT_HASH_REQUIRED'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO predecessor
  FROM memory_candidate
  WHERE tenant_id = p_tenant_id
    AND id = p_predecessor_id
  FOR UPDATE;

  IF NOT FOUND OR predecessor.status <> 'pending' THEN
    RAISE EXCEPTION 'MEMORY_REVISION_PREDECESSOR_NOT_PENDING'
      USING ERRCODE = 'P0002';
  END IF;
  IF predecessor.proposed_by <> p_proposer_id THEN
    RAISE EXCEPTION 'MEMORY_REVISION_PROPOSER_REQUIRED'
      USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO workflow
  FROM review_request
  WHERE tenant_id = p_tenant_id
    AND surface = 'memory'
    AND subject_type = 'memory_candidate'
    AND subject_id = p_predecessor_id::text
  FOR UPDATE;

  IF NOT FOUND OR workflow.status <> 'changes_needed' THEN
    RAISE EXCEPTION 'MEMORY_REVISION_CHANGES_NOT_REQUESTED'
      USING ERRCODE = '55000';
  END IF;
  IF workflow.requested_by <> p_proposer_id THEN
    RAISE EXCEPTION 'MEMORY_REVISION_WORKFLOW_PROPOSER_MISMATCH'
      USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM memory_candidate
    WHERE tenant_id = p_tenant_id
      AND predecessor_candidate_id = p_predecessor_id
  ) THEN
    RAISE EXCEPTION 'MEMORY_REVISION_SUCCESSOR_EXISTS'
      USING ERRCODE = '23505';
  END IF;

  root_id := COALESCE(predecessor.revision_root_id, predecessor.id);
  next_revision := predecessor.revision_number + 1;
  superseded_at := now();

  INSERT INTO memory_candidate
  SELECT (
    jsonb_populate_record(
      NULL::memory_candidate,
      to_jsonb(predecessor)
      || jsonb_build_object(
        'id', p_successor_id,
        'payload_jsonb', p_payload,
        'provenance_jsonb', p_provenance,
        'status', 'pending',
        'committed_memory_id', NULL,
        'committed_memory_item_id', NULL,
        'decided_by', NULL,
        'decided_at', NULL,
        'created_at', superseded_at,
        'source_content_hash', p_source_content_hash,
        'source_version', 'candidate:' || p_successor_id::text,
        'origin_trace_id', p_successor_id::text,
        'revision_root_id', root_id,
        'predecessor_candidate_id', predecessor.id,
        'revision_number', next_revision,
        'superseded_by_id', NULL
      )
    )
  ).*;

  UPDATE memory_candidate
  SET status = 'superseded',
      superseded_by_id = p_successor_id,
      decided_by = p_proposer_id,
      decided_at = superseded_at
  WHERE tenant_id = p_tenant_id
    AND id = p_predecessor_id;

  -- Keep the original reviewer's changes-requested attribution intact. The
  -- proposer supersession is a separate event represented in bounded metadata
  -- and the audit ledger, not by overwriting decided_by/decided_at.
  UPDATE review_request
  SET status = 'superseded',
      payload_jsonb = payload_jsonb || jsonb_build_object(
        'supersededByCandidateId', p_successor_id::text,
        'supersededByUserId', p_proposer_id::text,
        'supersededAt', superseded_at
      )
  WHERE id = workflow.id;

  RETURN QUERY
  SELECT p_successor_id, root_id, next_revision;
END;
$$;
