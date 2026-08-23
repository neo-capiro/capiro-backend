-- Fill with Meri agentic workflow — phases 1-3.
--
-- The original enrichment run is durable as a review record but executes inside
-- the API process. This migration adds a restart-safe specialist task queue and
-- the setup/progress state required by the new human identity gate. Canonical CRM
-- writes remain owned by the existing finding review/apply path.

ALTER TABLE client_profile_fill_run
  DROP CONSTRAINT IF EXISTS client_profile_fill_run_status_check;
ALTER TABLE client_profile_fill_run
  ADD CONSTRAINT client_profile_fill_run_status_check
  CHECK (status IN ('running', 'completed', 'partial', 'failed', 'cancelled'));

ALTER TABLE client_profile_fill_run
  ADD COLUMN IF NOT EXISTS workflow_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS stage VARCHAR(24) NOT NULL DEFAULT 'research',
  ADD COLUMN IF NOT EXISTS setup_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS selected_lda_ids INTEGER[] NOT NULL DEFAULT '{}'::integer[],
  ADD COLUMN IF NOT EXISTS attachment_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS last_progress_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;

ALTER TABLE client_profile_fill_run
  DROP CONSTRAINT IF EXISTS client_profile_fill_run_stage_check;
ALTER TABLE client_profile_fill_run
  ADD CONSTRAINT client_profile_fill_run_stage_check
  CHECK (stage IN (
    'preparing', 'research', 'review_ready', 'applying',
    'completed', 'failed', 'cancelled'
  ));

UPDATE client_profile_fill_run
   SET last_progress_at = COALESCE(last_progress_at, updated_at, started_at)
 WHERE last_progress_at IS NULL;

CREATE TABLE IF NOT EXISTS client_profile_fill_task (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  task_type VARCHAR(32) NOT NULL,
  task_key VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  depends_on UUID[] NOT NULL DEFAULT '{}'::uuid[],
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  input_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  output_summary_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_code VARCHAR(64) NULL,
  error_message TEXT NULL,
  worker_id VARCHAR(160) NULL,
  claimed_at TIMESTAMPTZ NULL,
  heartbeat_at TIMESTAMPTZ NULL,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_profile_fill_task_run_scope_fk
    FOREIGN KEY (run_id, tenant_id, client_id)
    REFERENCES client_profile_fill_run(id, tenant_id, client_id) ON DELETE CASCADE,
  CONSTRAINT client_profile_fill_task_type_check CHECK (task_type IN (
    'public_web', 'synced_email', 'sam_gov', 'lda',
    'program_elements', 'bill_tracker', 'client_document'
  )),
  CONSTRAINT client_profile_fill_task_status_check CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'
  )),
  CONSTRAINT client_profile_fill_task_run_key_uniq UNIQUE (run_id, task_key),
  CONSTRAINT client_profile_fill_task_terminal_check CHECK (
    (status IN ('completed', 'failed', 'skipped', 'cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS client_profile_fill_task_queue_idx
  ON client_profile_fill_task (status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS client_profile_fill_task_run_idx
  ON client_profile_fill_task (tenant_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS client_profile_fill_task_heartbeat_idx
  ON client_profile_fill_task (status, heartbeat_at)
  WHERE status = 'running';

ALTER TABLE client_profile_fill_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_task FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_profile_fill_task_select ON client_profile_fill_task;
CREATE POLICY client_profile_fill_task_select ON client_profile_fill_task
  FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_task_insert ON client_profile_fill_task;
CREATE POLICY client_profile_fill_task_insert ON client_profile_fill_task
  FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_task_update ON client_profile_fill_task;
CREATE POLICY client_profile_fill_task_update ON client_profile_fill_task
  FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_profile_fill_task_delete ON client_profile_fill_task;
CREATE POLICY client_profile_fill_task_delete ON client_profile_fill_task
  FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id());

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_task TO capiro_app;
  END IF;
END $$;
