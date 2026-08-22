-- Phase 27E — Quality Telemetry. Observe-only: this migration never touches
-- learning_signal, memory_candidate, or memory_items authority columns, and
-- adds no write path for them. It records, by ID only, which ContextPacket
-- and memory items fed a generated output and what happened to that output
-- afterward — never a document/message body (enforced in application code
-- by assertNoConfidentialContent, and here by column widths that make
-- storing a body impractical: the widest text-shaped column is 320 chars).

CREATE TABLE IF NOT EXISTS quality_telemetry_event (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id uuid NULL,
  client_id uuid NULL REFERENCES clients(id) ON DELETE CASCADE,

  surface varchar(24) NOT NULL
    CHECK (surface IN ('outreach', 'workspace', 'crm_fill', 'meetings', 'strategies', 'meri')),
  operation varchar(96) NOT NULL,
  event_type varchar(24) NOT NULL
    CHECK (event_type IN (
      'generated', 'edited', 'regenerated', 'approved', 'rejected', 'held',
      'superseded', 'corrected', 'feedback_positive', 'feedback_negative',
      'ignored', 'unknown'
    )),

  -- Bare polymorphic pointer (no FK — see the Prisma model doc comment: some
  -- referenced tables live in other services' databases, and Prisma cannot
  -- express a polymorphic FK even for the ones that don't).
  artifact_type varchar(40) NULL
    CHECK (artifact_type IS NULL OR artifact_type IN (
      'outreach_draft_version', 'workspace_doc_version', 'crm_fill_finding',
      'meeting_prep', 'meeting_debrief', 'strategy_node', 'strategy_change_set',
      'meri_message'
    )),
  artifact_id varchar(64) NULL,
  artifact_version_seq integer NULL,

  -- The Context Plane is centralized in this database regardless of which
  -- service requested it, so this is a real FK even for cross-service-
  -- originated events. SET NULL: packets are prunable trace data and must
  -- never pin a telemetry row (same reasoning as
  -- memory_items.origin_context_packet_id).
  context_packet_id uuid NULL REFERENCES context_packet(id) ON DELETE SET NULL,
  -- Counts only, never item bodies. Shape: { firmIdentity, firmPlaybook,
  -- userVoice, clientSteering, clientPeople }.
  context_layer_counts_jsonb jsonb NULL,

  -- Lifecycle linkage only — the decision's own audit evidence lives in
  -- memory_transition_audit, not here.
  learning_signal_id uuid NULL REFERENCES learning_signal(id) ON DELETE SET NULL,
  memory_candidate_id uuid NULL REFERENCES memory_candidate(id) ON DELETE SET NULL,

  -- Safe, numeric-only edit-burden metrics (percentChanged,
  -- normalizedEditDistance, versionsCount, timeToApprovalMs, ...). Never a
  -- diff or body — enforced in application code, not just documentation.
  edit_metrics_jsonb jsonb NULL,
  -- Short safe reason codes / correlation ids only.
  provenance_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,

  trace_id varchar(160) NULL,

  generated_at timestamptz NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Dedupe key — see computeQualityTelemetryIdempotencyKey. Deterministic
  -- from (surface, artifact_type, artifact_id, event_type,
  -- artifact_version_seq) so redelivery of the same underlying event never
  -- double-counts.
  idempotency_key varchar(320) NOT NULL,

  CONSTRAINT quality_telemetry_event_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS quality_telemetry_event_tenant_surface_type_idx
  ON quality_telemetry_event (tenant_id, surface, event_type, observed_at DESC);
CREATE INDEX IF NOT EXISTS quality_telemetry_event_tenant_artifact_idx
  ON quality_telemetry_event (tenant_id, artifact_type, artifact_id);
CREATE INDEX IF NOT EXISTS quality_telemetry_event_tenant_client_idx
  ON quality_telemetry_event (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS quality_telemetry_event_context_packet_idx
  ON quality_telemetry_event (context_packet_id);
CREATE INDEX IF NOT EXISTS quality_telemetry_event_learning_signal_idx
  ON quality_telemetry_event (learning_signal_id);

ALTER TABLE quality_telemetry_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_telemetry_event FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quality_telemetry_event_tenant_isolation ON quality_telemetry_event;
CREATE POLICY quality_telemetry_event_tenant_isolation ON quality_telemetry_event
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- Append-only: an event's lifecycle step is always a NEW row (e.g.
    -- "edited" after "generated"), never a mutation of a prior row, so no
    -- UPDATE/DELETE grant is needed — matches the audit-ledger convention
    -- (memory_transition_audit grants the same two verbs).
    GRANT SELECT, INSERT ON quality_telemetry_event TO capiro_app;
  END IF;
END $$;

-- Join row: "this memory item was included in the packet behind this
-- telemetry event." Separate from quality_telemetry_event so per-memory-item
-- usefulness is answered by aggregating rows here, never by counters
-- mutated onto memory_items itself.
CREATE TABLE IF NOT EXISTS quality_telemetry_memory_item_use (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Denormalized from the parent event so the tenant-scope guard and RLS
  -- both apply here directly, without requiring a join through the parent.
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  telemetry_event_id uuid NOT NULL REFERENCES quality_telemetry_event(id) ON DELETE CASCADE,
  -- SET NULL (not RESTRICT), matching memory_candidate's own FKs to
  -- memory_items — a hard-deleted memory row must never block deleting or
  -- reading historical telemetry.
  memory_item_id uuid NULL REFERENCES memory_items(id) ON DELETE SET NULL,
  context_layer varchar(24) NOT NULL
    CHECK (context_layer IN (
      'firm-identity', 'firm-playbook', 'user-voice', 'client-steering', 'client-people'
    )),

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT quality_telemetry_memory_item_use_event_item_unique UNIQUE (telemetry_event_id, memory_item_id)
);

CREATE INDEX IF NOT EXISTS quality_telemetry_memory_item_use_item_idx
  ON quality_telemetry_memory_item_use (memory_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS quality_telemetry_memory_item_use_tenant_item_idx
  ON quality_telemetry_memory_item_use (tenant_id, memory_item_id);

ALTER TABLE quality_telemetry_memory_item_use ENABLE ROW LEVEL SECURITY;
ALTER TABLE quality_telemetry_memory_item_use FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quality_telemetry_memory_item_use_tenant_isolation ON quality_telemetry_memory_item_use;
CREATE POLICY quality_telemetry_memory_item_use_tenant_isolation ON quality_telemetry_memory_item_use
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT ON quality_telemetry_memory_item_use TO capiro_app;
  END IF;
END $$;
