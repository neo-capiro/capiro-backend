-- Fill with Meri completion workflow: federal footprint, facilities/districts,
-- advocacy lifecycle, reconciliation, completion audit, and incremental refresh.
--
-- Advanced specialists deliberately use their own task ledger. The Phase 1-3
-- worker only understands the original seven task types and must never claim a
-- task it cannot execute. Both ledgers roll up into one user-visible run.

ALTER TABLE client_profile_fill_finding
  DROP CONSTRAINT IF EXISTS client_profile_fill_finding_kind_check;
ALTER TABLE client_profile_fill_finding
  ADD CONSTRAINT client_profile_fill_finding_kind_check
  CHECK (kind IN (
    'profile_field',
    'government_identity',
    'person',
    'facility',
    'capability',
    'lda_identity',
    'lda_history',
    'program_element',
    'bill_recommendation',
    'relationship_link',
    'federal_footprint',
    'facility_resolution',
    'district_nexus',
    'advocacy_record',
    'advocacy_outcome',
    'profile_completion'
  ));

CREATE TABLE IF NOT EXISTS client_profile_fill_extension_task (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id UUID NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  task_type VARCHAR(40) NOT NULL,
  task_key VARCHAR(200) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued',
  depends_on TEXT[] NOT NULL DEFAULT '{}'::text[],
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
  CONSTRAINT client_profile_fill_extension_task_run_scope_fk
    FOREIGN KEY (run_id, tenant_id, client_id)
    REFERENCES client_profile_fill_run(id, tenant_id, client_id) ON DELETE CASCADE,
  CONSTRAINT client_profile_fill_extension_task_type_check CHECK (task_type IN (
    'federal_market',
    'facility_resolution',
    'district_nexus',
    'advocacy_history',
    'lifecycle_outcomes',
    'reconciliation',
    'completion_audit'
  )),
  CONSTRAINT client_profile_fill_extension_task_status_check CHECK (status IN (
    'queued', 'running', 'completed', 'failed', 'skipped', 'cancelled'
  )),
  CONSTRAINT client_profile_fill_extension_task_run_key_uniq UNIQUE (run_id, task_key),
  CONSTRAINT client_profile_fill_extension_task_terminal_check CHECK (
    (status IN ('completed', 'failed', 'skipped', 'cancelled') AND completed_at IS NOT NULL)
    OR (status IN ('queued', 'running') AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS client_profile_fill_extension_task_queue_idx
  ON client_profile_fill_extension_task (status, next_attempt_at, created_at)
  WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS client_profile_fill_extension_task_run_idx
  ON client_profile_fill_extension_task (tenant_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS client_profile_fill_extension_task_heartbeat_idx
  ON client_profile_fill_extension_task (status, heartbeat_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS client_advocacy_record (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  record_type VARCHAR(48) NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NULL,
  activity_date DATE NULL,
  status VARCHAR(40) NULL,
  outcome TEXT NULL,
  source_type VARCHAR(48) NOT NULL,
  source_id VARCHAR(200) NULL,
  source_url TEXT NULL,
  evidence_class VARCHAR(32) NOT NULL,
  confidence NUMERIC(5,4) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  external_key VARCHAR(300) NOT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_advocacy_record_evidence_check CHECK (evidence_class IN (
    'PUBLIC_VERIFIED', 'CLIENT_VERIFIED', 'PRIVATE_ACTIVITY', 'INFERRED'
  )),
  CONSTRAINT client_advocacy_record_external_uniq UNIQUE (tenant_id, client_id, external_key)
);

CREATE INDEX IF NOT EXISTS client_advocacy_record_client_date_idx
  ON client_advocacy_record (tenant_id, client_id, activity_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS client_advocacy_record_source_idx
  ON client_advocacy_record (tenant_id, source_type, source_id);

CREATE TABLE IF NOT EXISTS client_profile_fill_source_cursor (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source VARCHAR(48) NOT NULL,
  watermark_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_successful_at TIMESTAMPTZ NULL,
  last_attempt_at TIMESTAMPTZ NULL,
  last_error TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_profile_fill_source_cursor_uniq UNIQUE (tenant_id, client_id, source)
);

CREATE TABLE IF NOT EXISTS client_profile_fill_schedule (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT false,
  cadence_hours INTEGER NOT NULL DEFAULT 168 CHECK (cadence_hours BETWEEN 6 AND 720),
  sources TEXT[] NOT NULL DEFAULT ARRAY[
    'public_web','synced_email','sam_gov','lda','program_elements','bill_tracker'
  ]::text[],
  next_run_at TIMESTAMPTZ NULL,
  last_enqueued_at TIMESTAMPTZ NULL,
  updated_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_profile_fill_schedule_client_uniq UNIQUE (tenant_id, client_id)
);

CREATE INDEX IF NOT EXISTS client_profile_fill_schedule_due_idx
  ON client_profile_fill_schedule (next_run_at)
  WHERE enabled = true;

ALTER TABLE client_profile_fill_extension_task ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_extension_task FORCE ROW LEVEL SECURITY;
ALTER TABLE client_advocacy_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_advocacy_record FORCE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_source_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_source_cursor FORCE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_schedule FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'client_profile_fill_extension_task',
    'client_advocacy_record',
    'client_profile_fill_source_cursor',
    'client_profile_fill_schedule'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_select ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_select ON %I FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I_insert ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_insert ON %I FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I_update ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_update ON %I FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name, table_name
    );
    EXECUTE format('DROP POLICY IF EXISTS %I_delete ON %I', table_name, table_name);
    EXECUTE format(
      'CREATE POLICY %I_delete ON %I FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name, table_name
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_extension_task TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_advocacy_record TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_source_cursor TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_schedule TO capiro_app;
  END IF;
END $$;
