-- Fill with Meri — durable client-profile enrichment runs + reviewable findings.
-- The workflow discovers candidate data first; canonical client records are changed
-- only by an explicit review/apply action. Both tables are tenant-owned and FORCE RLS.

CREATE TABLE IF NOT EXISTS client_profile_fill_run (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  created_by_user_id uuid NULL,
  status varchar(16) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'partial', 'failed')),
  requested_sources text[] NOT NULL DEFAULT '{}'::text[],
  source_states_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_profile_fill_run_scope_uniq UNIQUE (id, tenant_id, client_id)
);

CREATE INDEX IF NOT EXISTS client_profile_fill_run_client_created_idx
  ON client_profile_fill_run (tenant_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_profile_fill_run_status_idx
  ON client_profile_fill_run (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS client_profile_fill_finding (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  run_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind varchar(32) NOT NULL
    CHECK (kind IN (
      'profile_field', 'government_identity', 'person', 'facility', 'capability',
      'lda_identity', 'lda_history', 'program_element'
    )),
  target_key varchar(160) NOT NULL,
  source varchar(32) NOT NULL
    CHECK (source IN ('public_web', 'website', 'synced_email', 'sam_gov', 'lda', 'program_elements')),
  fact_kind varchar(16) NOT NULL DEFAULT 'fact'
    CHECK (fact_kind IN ('fact', 'recommendation')),
  current_value_jsonb jsonb NULL,
  proposed_value_jsonb jsonb NOT NULL,
  evidence_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status varchar(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'informational')),
  content_hash char(64) NOT NULL,
  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  rejection_reason text NULL,
  applied_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_profile_fill_finding_run_scope_fk
    FOREIGN KEY (run_id, tenant_id, client_id)
    REFERENCES client_profile_fill_run(id, tenant_id, client_id) ON DELETE CASCADE,
  CONSTRAINT client_profile_fill_finding_run_hash_uniq UNIQUE (run_id, content_hash),
  CONSTRAINT client_profile_fill_finding_review_state_chk CHECK (
    (status IN ('accepted', 'rejected') AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    OR (status IN ('pending', 'informational') AND reviewed_by IS NULL AND reviewed_at IS NULL)
  ),
  CONSTRAINT client_profile_fill_finding_applied_state_chk CHECK (
    (status = 'accepted' AND applied_at IS NOT NULL)
    OR (status <> 'accepted' AND applied_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS client_profile_fill_finding_client_status_idx
  ON client_profile_fill_finding (tenant_id, client_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS client_profile_fill_finding_run_idx
  ON client_profile_fill_finding (tenant_id, run_id, created_at ASC);
CREATE INDEX IF NOT EXISTS client_profile_fill_finding_hash_idx
  ON client_profile_fill_finding (tenant_id, client_id, content_hash, status);

ALTER TABLE client_profile_fill_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_run FORCE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_profile_fill_finding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_profile_fill_run_select ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_select ON client_profile_fill_run
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_run_insert ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_insert ON client_profile_fill_run
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_run_update ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_update ON client_profile_fill_run
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_run_delete ON client_profile_fill_run;
CREATE POLICY client_profile_fill_run_delete ON client_profile_fill_run
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DROP POLICY IF EXISTS client_profile_fill_finding_select ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_select ON client_profile_fill_finding
  FOR SELECT USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_finding_insert ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_insert ON client_profile_fill_finding
  FOR INSERT WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_finding_update ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_update ON client_profile_fill_finding
  FOR UPDATE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
DROP POLICY IF EXISTS client_profile_fill_finding_delete ON client_profile_fill_finding;
CREATE POLICY client_profile_fill_finding_delete ON client_profile_fill_finding
  FOR DELETE USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_run TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_profile_fill_finding TO capiro_app;
  END IF;
END $$;
