-- Phase 27F — Institutional-Context Effectiveness Evaluation. Observe/compare
-- only: this migration adds no write path to learning_signal,
-- memory_candidate, memory_items, or context_packet. It records ONE
-- controlled shadow comparison per sampled request — never a prompt/output
-- body (enforced in application code by assertNoConfidentialEvaluationContent,
-- and here by column widths that make storing a body impractical: the
-- widest text-shaped column is 400 chars).

CREATE TABLE IF NOT EXISTS evaluation_record (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NULL,

  surface varchar(24) NOT NULL
    CHECK (surface IN ('outreach', 'workspace', 'crm_fill', 'meetings', 'strategies', 'meri')),
  operation varchar(96) NOT NULL,
  evaluation_type varchar(40) NOT NULL
    CHECK (evaluation_type IN ('institutional_context_ablation')),

  status varchar(16) NOT NULL
    CHECK (status IN ('pending', 'running', 'completed', 'skipped', 'failed')),
  skip_reason varchar(40) NULL
    CHECK (skip_reason IS NULL OR skip_reason IN (
      'feature_disabled', 'not_sampled', 'missing_packet', 'missing_context',
      'no_institutional_context', 'unsupported_operation', 'sensitive_operation',
      'insufficient_authoritative_input', 'provider_unavailable', 'budget_exceeded'
    )),
  -- A short code, never a stack trace or provider error body.
  failure_reason varchar(160) NULL,

  -- The TREATMENT run's own already-resolved, already-persisted
  -- ContextPacket — frozen historical evidence. SET NULL: packets are
  -- prunable trace data and must never pin an evaluation row.
  context_packet_id uuid NULL REFERENCES context_packet(id) ON DELETE SET NULL,
  -- Convenience join to Phase 27E's canonical outcome-truth row for the same
  -- artifact, when one exists. This table never duplicates that data.
  quality_telemetry_event_id uuid NULL REFERENCES quality_telemetry_event(id) ON DELETE SET NULL,

  -- Bare polymorphic pointer (no FK — some referenced tables live in other
  -- services' databases, same reasoning as quality_telemetry_event).
  -- Superset of quality_telemetry_event's artifact-type vocabulary, plus
  -- 'crm_fill_extraction': CRM Fill has no per-finding ContextPacket (one
  -- packet backs a whole multi-source run, per
  -- crm-fill-finding.telemetry-adapter.ts's own doc comment) — the natural
  -- evaluation unit is one source-extraction call within a run, not one
  -- finding, so it needs a value quality_telemetry_event never did.
  treatment_artifact_type varchar(40) NULL
    CHECK (treatment_artifact_type IS NULL OR treatment_artifact_type IN (
      'outreach_draft_version', 'workspace_doc_version', 'crm_fill_finding',
      'crm_fill_extraction', 'meeting_prep', 'meeting_debrief', 'strategy_node',
      'strategy_change_set', 'meri_message'
    )),
  treatment_artifact_id varchar(64) NOT NULL,
  treatment_artifact_version_seq integer NULL,

  -- Identity/comparison only — never the output body itself.
  treatment_output_hash varchar(128) NULL,
  control_output_hash varchar(128) NULL,
  control_projection_policy varchar(64) NULL
    CHECK (control_projection_policy IS NULL OR control_projection_policy IN (
      'withhold_all_institutional_layers'
    )),

  -- Numeric/boolean/enum dimensions only — never a diff or body.
  metrics_jsonb jsonb NULL,
  -- Optional blinded model-judge result. Null whenever deterministic metrics
  -- alone were used (the default).
  judge_jsonb jsonb NULL,
  -- Cost/token accounting for the one incremental provider call this
  -- evaluation added. Unknown fields stay null — never coerced to 0.
  cost_jsonb jsonb NULL,

  sampling_key varchar(320) NOT NULL,
  config_version varchar(32) NOT NULL,

  trace_id varchar(160) NULL,

  observed_at timestamptz NOT NULL,
  started_at timestamptz NULL,
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- Dedupe key — see computeEvaluationIdempotencyKey. A retry of the same
  -- underlying request reaches the same row, never a duplicate.
  idempotency_key varchar(400) NOT NULL,

  CONSTRAINT evaluation_record_tenant_idempotency_unique UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS evaluation_record_tenant_surface_status_idx
  ON evaluation_record (tenant_id, surface, status, observed_at DESC);
CREATE INDEX IF NOT EXISTS evaluation_record_tenant_artifact_idx
  ON evaluation_record (tenant_id, treatment_artifact_type, treatment_artifact_id);
CREATE INDEX IF NOT EXISTS evaluation_record_tenant_client_idx
  ON evaluation_record (tenant_id, client_id);
CREATE INDEX IF NOT EXISTS evaluation_record_context_packet_idx
  ON evaluation_record (context_packet_id);
CREATE INDEX IF NOT EXISTS evaluation_record_quality_telemetry_event_idx
  ON evaluation_record (quality_telemetry_event_id);
-- Supports a lightweight staleness sweep only (mark an abandoned
-- 'running'/'pending' row 'failed' after a timeout) — not a work-claiming
-- queue. See the Prisma model doc comment for why: the replay's inputs
-- (evidence/prompt) are never persisted, so execution is always the
-- in-process detached task started at generation time, never a later
-- worker resuming from this row.
CREATE INDEX IF NOT EXISTS evaluation_record_status_created_idx
  ON evaluation_record (status, created_at);

ALTER TABLE evaluation_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_record FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evaluation_record_tenant_isolation ON evaluation_record;
CREATE POLICY evaluation_record_tenant_isolation ON evaluation_record
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    -- Lifecycle transitions (pending -> running -> completed/failed) update
    -- the SAME row in place, unlike quality_telemetry_event's append-only
    -- ledger — this is a status machine, not an audit trail.
    GRANT SELECT, INSERT, UPDATE ON evaluation_record TO capiro_app;
  END IF;
END $$;
