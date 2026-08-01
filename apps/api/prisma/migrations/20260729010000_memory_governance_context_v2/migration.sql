-- MeriV2 Phase 3 — Institutional Memory and ContextPacket v2
-- Additive only. Existing v1 columns/tables remain available for rollback.
-- This migration is NOT executed by this branch/task.

-- ---------------------------------------------------------------------------
-- Governed memory metadata
-- Conservative defaults deliberately carry no approval or authority.
-- ---------------------------------------------------------------------------
ALTER TABLE memory_items
  ADD COLUMN IF NOT EXISTS memory_class varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS memory_authority varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS memory_scope varchar(24) NOT NULL DEFAULT 'firm',
  ADD COLUMN IF NOT EXISTS governed_status varchar(24) NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS source_type varchar(40) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS source_excerpt text,
  ADD COLUMN IF NOT EXISTS source_content_hash varchar(96),
  ADD COLUMN IF NOT EXISTS source_version varchar(160),
  ADD COLUMN IF NOT EXISTS asserted_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS second_approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS second_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS as_of timestamptz,
  ADD COLUMN IF NOT EXISTS effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS conflict_status varchar(24) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS conflict_group_id uuid,
  ADD COLUMN IF NOT EXISTS controlling_item_id uuid,
  ADD COLUMN IF NOT EXISTS origin_surface varchar(48),
  ADD COLUMN IF NOT EXISTS origin_trace_id varchar(160),
  ADD COLUMN IF NOT EXISTS origin_context_packet_id uuid,
  ADD COLUMN IF NOT EXISTS origin_model varchar(160),
  ADD COLUMN IF NOT EXISTS origin_prompt_version varchar(80),
  ADD COLUMN IF NOT EXISTS instructions_allowed boolean NOT NULL DEFAULT false;

ALTER TABLE memory_candidate
  ADD COLUMN IF NOT EXISTS memory_class varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS memory_authority varchar(40) NOT NULL DEFAULT 'legacy_unclassified',
  ADD COLUMN IF NOT EXISTS memory_scope varchar(24) NOT NULL DEFAULT 'firm',
  ADD COLUMN IF NOT EXISTS governed_status varchar(24) NOT NULL DEFAULT 'suggested',
  ADD COLUMN IF NOT EXISTS source_type varchar(40) NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS source_id text,
  ADD COLUMN IF NOT EXISTS source_ref text,
  ADD COLUMN IF NOT EXISTS source_excerpt text,
  ADD COLUMN IF NOT EXISTS source_content_hash varchar(96),
  ADD COLUMN IF NOT EXISTS source_version varchar(160),
  ADD COLUMN IF NOT EXISTS asserted_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS second_approved_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS second_approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS as_of timestamptz,
  ADD COLUMN IF NOT EXISTS effective_from timestamptz,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_cadence_days integer,
  ADD COLUMN IF NOT EXISTS review_due_at timestamptz,
  ADD COLUMN IF NOT EXISTS conflict_status varchar(24) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS conflict_group_id uuid,
  ADD COLUMN IF NOT EXISTS controlling_item_id uuid,
  ADD COLUMN IF NOT EXISTS sensitivity varchar(24) NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS retention_policy_jsonb jsonb,
  ADD COLUMN IF NOT EXISTS legal_hold boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS origin_surface varchar(48),
  ADD COLUMN IF NOT EXISTS origin_trace_id varchar(160),
  ADD COLUMN IF NOT EXISTS origin_context_packet_id uuid,
  ADD COLUMN IF NOT EXISTS origin_model varchar(160),
  ADD COLUMN IF NOT EXISTS origin_prompt_version varchar(80),
  ADD COLUMN IF NOT EXISTS instructions_allowed boolean NOT NULL DEFAULT false;

-- Existing candidate lifecycle values remain untouched for rollback. The governed
-- column records the v2 state without making a pending legacy row active.
UPDATE memory_candidate
SET memory_scope = CASE scope
      WHEN 'personal' THEN 'user_private'
      WHEN 'client' THEN 'client'
      ELSE 'firm'
    END,
    governed_status = CASE status
      WHEN 'pending' THEN 'pending_review'
      WHEN 'rejected' THEN 'rejected'
      WHEN 'approved' THEN 'active'
      WHEN 'auto_committed' THEN 'active'
      ELSE 'suggested'
    END
WHERE memory_scope = 'firm' AND memory_class = 'legacy_unclassified';

-- Existing item scope can be inferred deterministically, but class/authority cannot.
UPDATE memory_items
SET memory_scope = CASE
      WHEN client_id IS NOT NULL THEN 'client'
      WHEN visibility = 'user' OR owner_user_id IS NOT NULL THEN 'user_private'
      ELSE 'firm'
    END,
    governed_status = CASE status
      WHEN 'active' THEN 'pending_review'
      WHEN 'superseded' THEN 'superseded'
      WHEN 'revoked' THEN 'revoked'
      ELSE 'pending_review'
    END
WHERE memory_class = 'legacy_unclassified';

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_memory_class_check
    CHECK (memory_class IN (
      'institutional_authoritative','client_steering','user_preference',
      'episodic_working','legacy_unclassified'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_authority_check
    CHECK (memory_authority IN (
      'firm_approved','client_approved','external_authoritative','user_asserted',
      'analyst_verified','working_draft','model_inferred','legacy_unclassified'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_scope_check
    CHECK (memory_scope IN ('firm','client','user_private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_governed_status_check
    CHECK (governed_status IN (
      'suggested','pending_review','active','stale','conflicted','superseded',
      'revoked','rejected','expired'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_conflict_status_check
    CHECK (conflict_status IN ('none','open','resolved','controlling'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_source_excerpt_cap_check
    CHECK (source_excerpt IS NULL OR octet_length(source_excerpt) <= 8000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_confidence_range_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_ephemeral_ttl_check
    CHECK (memory_class <> 'episodic_working' OR expires_at IS NOT NULL OR valid_until IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_items ADD CONSTRAINT memory_items_instruction_authority_check
    CHECK (
      instructions_allowed = false OR (
        memory_class = 'institutional_authoritative' AND
        memory_authority = 'firm_approved' AND
        approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_memory_class_check
    CHECK (memory_class IN (
      'institutional_authoritative','client_steering','user_preference',
      'episodic_working','legacy_unclassified'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_authority_check
    CHECK (memory_authority IN (
      'firm_approved','client_approved','external_authoritative','user_asserted',
      'analyst_verified','working_draft','model_inferred','legacy_unclassified'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_scope_check
    CHECK (memory_scope IN ('firm','client','user_private'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_governed_status_check
    CHECK (governed_status IN (
      'suggested','pending_review','active','stale','conflicted','superseded',
      'revoked','rejected','expired'
    ));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_conflict_status_check
    CHECK (conflict_status IN ('none','open','resolved','controlling'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_source_excerpt_cap_check
    CHECK (source_excerpt IS NULL OR octet_length(source_excerpt) <= 8000);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_confidence_range_check
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE memory_candidate ADD CONSTRAINT memory_candidate_ephemeral_ttl_check
    CHECK (memory_class <> 'episodic_working' OR expires_at IS NOT NULL OR valid_until IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS memory_items_governed_recall_idx
  ON memory_items (tenant_id, governed_status, memory_class, memory_scope, client_id);
CREATE INDEX IF NOT EXISTS memory_items_review_due_idx
  ON memory_items (tenant_id, review_due_at)
  WHERE governed_status IN ('active','stale','conflicted');
CREATE INDEX IF NOT EXISTS memory_items_conflict_group_idx
  ON memory_items (tenant_id, conflict_group_id)
  WHERE conflict_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_items_source_identity_idx
  ON memory_items (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_candidate_governed_queue_idx
  ON memory_candidate (tenant_id, governed_status, memory_class, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_candidate_source_identity_idx
  ON memory_candidate (tenant_id, source_type, source_id)
  WHERE source_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Fine-grained edit/review/approval grants. This deliberately does not overload
-- client_memory_access, whose existing meaning is ethical-wall read permission.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_access_grant (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permissions text[] NOT NULL DEFAULT '{}',
  status varchar(16) NOT NULL DEFAULT 'active',
  granted_by_user_id uuid,
  reason text,
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_access_grant_status_check CHECK (status IN ('active','revoked','expired')),
  CONSTRAINT memory_access_grant_permissions_check CHECK (
    permissions <@ ARRAY['propose','review','approve','edit','confirm','mark_stale','revoke','resolve_conflict']::text[]
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_access_grant_unique_active
  ON memory_access_grant (tenant_id, client_id, user_id)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS memory_access_grant_user_idx
  ON memory_access_grant (tenant_id, user_id, status);

ALTER TABLE memory_access_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_access_grant FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_access_grant_tenant_isolation ON memory_access_grant;
CREATE POLICY memory_access_grant_tenant_isolation ON memory_access_grant
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- Immutable transition evidence. Contains ids/status/reason only, never bodies.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_transition_audit (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_item_id uuid,
  memory_candidate_id uuid,
  actor_user_id uuid,
  effective_tenant_id uuid NOT NULL,
  client_id uuid,
  from_status varchar(24),
  to_status varchar(24) NOT NULL,
  reason_code varchar(48) NOT NULL,
  reason text NOT NULL,
  source_type varchar(40),
  source_id text,
  proposal_id uuid,
  impersonation_session_id uuid,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_transition_exact_subject_check CHECK (
    (memory_item_id IS NOT NULL)::int + (memory_candidate_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT memory_transition_metadata_size_check CHECK (octet_length(metadata_jsonb::text) <= 32768)
);
CREATE INDEX IF NOT EXISTS memory_transition_audit_tenant_time_idx
  ON memory_transition_audit (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_transition_audit_item_idx
  ON memory_transition_audit (tenant_id, memory_item_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS memory_transition_audit_candidate_idx
  ON memory_transition_audit (tenant_id, memory_candidate_id, occurred_at DESC);

ALTER TABLE memory_transition_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_transition_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_transition_audit_tenant_isolation ON memory_transition_audit;
CREATE POLICY memory_transition_audit_tenant_isolation ON memory_transition_audit
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- Durable, idempotent cleanup work. The governed status suppresses recall in the
-- same transaction; this table removes stale secondary projections afterwards.
CREATE TABLE IF NOT EXISTS memory_cleanup_outbox (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL,
  clio_memory_id uuid,
  operation varchar(32) NOT NULL,
  idempotency_key varchar(192) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT memory_cleanup_operation_check CHECK (
    operation IN ('revoke_projections','supersede_projections','expire_projections','purge_projections')
  ),
  CONSTRAINT memory_cleanup_status_check CHECK (status IN ('pending','running','completed','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS memory_cleanup_outbox_idempotency_key
  ON memory_cleanup_outbox (tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS memory_cleanup_outbox_pending_idx
  ON memory_cleanup_outbox (status, next_attempt_at, created_at);

ALTER TABLE memory_cleanup_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_cleanup_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_cleanup_outbox_tenant_isolation ON memory_cleanup_outbox;
CREATE POLICY memory_cleanup_outbox_tenant_isolation ON memory_cleanup_outbox
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- ContextPacket v2 metadata. Items/exclusions remain bounded JSON metadata;
-- rendered body text is never copied into this table.
-- ---------------------------------------------------------------------------
-- packet_version is OWNED by 20260803010000_engagement_generation_gateway, where
-- 1 = legacy steering-only trace and 2 = a complete Evidence Packet. That name
-- sorts AFTER this migration, so a freshly built environment applies this one
-- first while prod (which already has the engagement migration) applies it last.
-- The definition below is therefore kept BYTE-COMPATIBLE with the engagement
-- migration's (integer NOT NULL DEFAULT 2) so whichever runs first wins
-- identically and the other's ADD COLUMN IF NOT EXISTS is a true no-op. It was
-- previously `smallint NOT NULL DEFAULT 1`, which meant a fresh environment got
-- a smallint column defaulting to 1 -- diverging in BOTH type and default from
-- prod, and silently making every new write claim to be a legacy v1 trace.
ALTER TABLE context_packet
  ADD COLUMN IF NOT EXISTS packet_version integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS effective_tenant_id uuid,
  ADD COLUMN IF NOT EXISTS actor_user_id uuid,
  ADD COLUMN IF NOT EXISTS trace_id varchar(160),
  ADD COLUMN IF NOT EXISTS prompt_version varchar(80),
  ADD COLUMN IF NOT EXISTS policy_version varchar(80),
  ADD COLUMN IF NOT EXISTS compiler_version varchar(80),
  ADD COLUMN IF NOT EXISTS required_layers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS health_jsonb jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS total_token_budget integer,
  ADD COLUMN IF NOT EXISTS used_tokens integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS incomplete boolean NOT NULL DEFAULT false;

-- Backfill the new tenant column only. This deliberately no longer writes
-- packet_version: `WHERE effective_tenant_id IS NULL` matches EVERY pre-existing
-- row (the column is created NULL just above), so `SET packet_version = 1` here
-- stamped 1 over every row in the table -- including genuine complete Evidence
-- Packets. The engagement migration downgrades legacy rows correctly and
-- narrowly, with `WHERE packet_version = 2 AND packet_hash IS NULL`; relabelling
-- a real v2 packet as a v1 trace is exactly what that predicate exists to avoid.
UPDATE context_packet
SET effective_tenant_id = tenant_id
WHERE effective_tenant_id IS NULL;

ALTER TABLE context_packet ALTER COLUMN effective_tenant_id SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE context_packet ADD CONSTRAINT context_packet_version_check
    CHECK (packet_version IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE context_packet ADD CONSTRAINT context_packet_budget_check
    CHECK (
      (total_token_budget IS NULL OR total_token_budget >= 0) AND
      used_tokens >= 0 AND
      (total_token_budget IS NULL OR used_tokens <= total_token_budget)
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS context_packet_v2_trace_idx
  ON context_packet (tenant_id, trace_id, created_at DESC)
  WHERE packet_version = 2;
CREATE INDEX IF NOT EXISTS context_packet_v2_surface_idx
  ON context_packet (tenant_id, surface, client_id, created_at DESC)
  WHERE packet_version = 2;

COMMENT ON COLUMN memory_items.memory_class IS
  'Governed class. legacy_unclassified is a quarantine state, never active authority.';
COMMENT ON COLUMN memory_items.memory_authority IS
  'Controlled authority vocabulary; never inferred from model confidence.';
COMMENT ON COLUMN memory_items.instructions_allowed IS
  'True only for an explicitly approved firm institutional playbook.';
COMMENT ON TABLE memory_transition_audit IS
  'Immutable SOC 2 evidence for governed memory lifecycle transitions; no memory bodies.';
COMMENT ON TABLE memory_cleanup_outbox IS
  'Durable secondary-projection cleanup after synchronous recall suppression.';
