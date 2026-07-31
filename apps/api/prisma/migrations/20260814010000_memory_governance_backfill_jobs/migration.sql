-- MeriV2 Phase 11 — reversible, drift-safe governed-memory backfill.
--
-- Additive control-plane tables only. This migration does not classify or mutate
-- any memory_items row. Operators must prepare a tenant-scoped job, explicitly
-- confirm that exact job for execution, and separately confirm the same job for
-- rollback. The row ledger preserves governance metadata only; no memory body,
-- title, prompt, provider payload, or customer communication is copied here.

CREATE TABLE IF NOT EXISTS memory_governance_backfill_job (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  classifier_version varchar(80) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'prepared',
  plan_hash varchar(64) NOT NULL,
  row_count integer NOT NULL,
  change_count integer NOT NULL,
  quarantine_count integer NOT NULL,
  prepared_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  rolled_back_at timestamptz,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_governance_backfill_job_status_check CHECK (
    status IN (
      'prepared',
      'executed',
      'execute_blocked_drift',
      'rolled_back',
      'rollback_partial'
    )
  ),
  CONSTRAINT memory_governance_backfill_job_counts_check CHECK (
    row_count >= 0 AND change_count >= 0 AND quarantine_count >= 0
    AND change_count <= row_count AND quarantine_count <= row_count
  ),
  CONSTRAINT memory_governance_backfill_job_metadata_size_check CHECK (
    octet_length(metadata_jsonb::text) <= 32768
  )
);

CREATE INDEX IF NOT EXISTS memory_governance_backfill_job_tenant_time_idx
  ON memory_governance_backfill_job (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_governance_backfill_job_tenant_status_idx
  ON memory_governance_backfill_job (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_governance_backfill_row (
  job_id uuid NOT NULL REFERENCES memory_governance_backfill_job(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_item_id uuid NOT NULL,
  should_update boolean NOT NULL,
  quarantined boolean NOT NULL,
  reason text NOT NULL,
  before_state_jsonb jsonb NOT NULL,
  expected_post_state_jsonb jsonb NOT NULL,
  before_hash varchar(64) NOT NULL,
  expected_post_hash varchar(64) NOT NULL,
  apply_status varchar(24) NOT NULL DEFAULT 'planned',
  rollback_status varchar(24) NOT NULL DEFAULT 'pending',
  applied_at timestamptz,
  rollback_checked_at timestamptz,
  rollback_observed_hash varchar(64),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, memory_item_id),
  CONSTRAINT memory_governance_backfill_row_apply_status_check CHECK (
    apply_status IN ('planned', 'not_needed', 'applied', 'blocked_drift')
  ),
  CONSTRAINT memory_governance_backfill_row_rollback_status_check CHECK (
    rollback_status IN ('pending', 'not_applied', 'restored', 'skipped_drift')
  ),
  CONSTRAINT memory_governance_backfill_row_before_size_check CHECK (
    octet_length(before_state_jsonb::text) <= 16384
  ),
  CONSTRAINT memory_governance_backfill_row_expected_size_check CHECK (
    octet_length(expected_post_state_jsonb::text) <= 16384
  )
);

CREATE INDEX IF NOT EXISTS memory_governance_backfill_row_tenant_item_idx
  ON memory_governance_backfill_row (tenant_id, memory_item_id);
CREATE INDEX IF NOT EXISTS memory_governance_backfill_row_job_apply_idx
  ON memory_governance_backfill_row (job_id, apply_status, memory_item_id);
CREATE INDEX IF NOT EXISTS memory_governance_backfill_row_job_rollback_idx
  ON memory_governance_backfill_row (job_id, rollback_status, memory_item_id);

CREATE TABLE IF NOT EXISTS memory_governance_backfill_event (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES memory_governance_backfill_job(id) ON DELETE CASCADE,
  memory_item_id uuid,
  event_type varchar(40) NOT NULL,
  reason_code varchar(80) NOT NULL,
  expected_hash varchar(64),
  observed_hash varchar(64),
  metadata_jsonb jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memory_governance_backfill_event_type_check CHECK (
    event_type IN (
      'prepared',
      'execute_started',
      'execute_blocked_drift',
      'row_applied',
      'execute_completed',
      'rollback_started',
      'row_restored',
      'row_skipped_drift',
      'rollback_completed'
    )
  ),
  CONSTRAINT memory_governance_backfill_event_metadata_size_check CHECK (
    octet_length(metadata_jsonb::text) <= 32768
  )
);

CREATE INDEX IF NOT EXISTS memory_governance_backfill_event_job_time_idx
  ON memory_governance_backfill_event (tenant_id, job_id, occurred_at, id);
CREATE INDEX IF NOT EXISTS memory_governance_backfill_event_item_time_idx
  ON memory_governance_backfill_event (tenant_id, memory_item_id, occurred_at)
  WHERE memory_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_memory_governance_backfill_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'memory_governance_backfill_event_append_only'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS memory_governance_backfill_event_append_only
  ON memory_governance_backfill_event;
CREATE TRIGGER memory_governance_backfill_event_append_only
BEFORE UPDATE OR DELETE ON memory_governance_backfill_event
FOR EACH ROW
EXECUTE FUNCTION reject_memory_governance_backfill_event_mutation();

ALTER TABLE memory_governance_backfill_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_governance_backfill_job FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_governance_backfill_job_tenant_isolation
  ON memory_governance_backfill_job;
CREATE POLICY memory_governance_backfill_job_tenant_isolation
  ON memory_governance_backfill_job
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE memory_governance_backfill_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_governance_backfill_row FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_governance_backfill_row_tenant_isolation
  ON memory_governance_backfill_row;
CREATE POLICY memory_governance_backfill_row_tenant_isolation
  ON memory_governance_backfill_row
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);

ALTER TABLE memory_governance_backfill_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_governance_backfill_event FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS memory_governance_backfill_event_tenant_isolation
  ON memory_governance_backfill_event;
CREATE POLICY memory_governance_backfill_event_tenant_isolation
  ON memory_governance_backfill_event
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
