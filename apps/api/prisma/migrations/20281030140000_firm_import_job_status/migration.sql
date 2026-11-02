-- SCRUM-173 / B12: durable job + item view over the EXISTING firm LDA client
-- importer. No queue, worker, retry or cancellation owner is introduced: the
-- request-owned importer writes these rows, and each successful item row is
-- committed with its canonical Client + confirmed clientIntelMapping effect.
--
-- Ordering contract: firm_import_jobs.created_at is timestamptz(3) and its
-- default is truncated to milliseconds. The API keyset cursor serialises that
-- value through a JavaScript Date (millisecond precision), so the ISO-8601
-- cursor round-trips exactly; id is the deterministic tie-break. This migration
-- is unapplied, so no deployed-data conversion is involved.
CREATE TYPE firm_import_job_status AS ENUM
  ('queued','running','partially_completed','failed','completed');
CREATE TYPE firm_import_item_outcome AS ENUM
  ('pending','created','already_present','rejected');

CREATE TABLE firm_import_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  requested_by_user_id uuid NOT NULL,
  request_key varchar(128) NOT NULL,
  request_sha256 char(64) NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  lda_registrant_id integer NOT NULL,
  requested_ids integer[] NOT NULL CHECK (cardinality(requested_ids) BETWEEN 1 AND 100),
  status firm_import_job_status NOT NULL DEFAULT 'queued',
  started_at timestamptz(6),
  finished_at timestamptz(6),
  created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT firm_import_jobs_tenant_fkey FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT firm_import_jobs_requested_by_fkey FOREIGN KEY (requested_by_user_id)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT firm_import_jobs_tenant_request_key UNIQUE (tenant_id, request_key),
  CONSTRAINT firm_import_jobs_tenant_id_key UNIQUE (tenant_id, id)
);
CREATE INDEX firm_import_jobs_page_idx
  ON firm_import_jobs (tenant_id, created_at DESC, id DESC);
CREATE INDEX firm_import_jobs_status_idx
  ON firm_import_jobs (tenant_id, status, created_at DESC, id DESC);

CREATE TABLE firm_import_job_items (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  lda_client_id integer NOT NULL,
  outcome firm_import_item_outcome NOT NULL DEFAULT 'pending',
  code varchar(64),
  client_id uuid,
  processed_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT firm_import_job_items_job_fkey FOREIGN KEY (tenant_id, job_id)
    REFERENCES firm_import_jobs (tenant_id, id) ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT firm_import_job_items_identity_key UNIQUE (tenant_id, job_id, lda_client_id),
  -- Rejected outcomes MUST carry one of the closed actionable codes; a NULL
  -- code makes this branch FALSE (not SQL NULL), so the CHECK rejects it.
  CONSTRAINT firm_import_job_items_outcome_shape CHECK (
    (outcome = 'pending' AND code IS NULL AND client_id IS NULL AND processed_at IS NULL)
    OR (outcome IN ('created','already_present') AND code IS NULL AND client_id IS NOT NULL AND processed_at IS NOT NULL)
    OR (outcome = 'rejected' AND code IS NOT NULL AND code IN
        ('NOT_OWN_CLIENT','LDA_CLIENT_NOT_FOUND','CLIENT_SLOT_LIMIT','INTERNAL_ERROR')
        AND client_id IS NULL AND processed_at IS NOT NULL)
  )
);

ALTER TABLE firm_import_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_import_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_import_jobs_isolation ON firm_import_jobs
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

ALTER TABLE firm_import_job_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE firm_import_job_items FORCE ROW LEVEL SECURITY;
CREATE POLICY firm_import_job_items_isolation ON firm_import_job_items
  USING (rls_bypass() OR tenant_id = current_tenant_id())
  WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id());

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='capiro_app') THEN
    REVOKE ALL ON firm_import_jobs FROM capiro_app;
    GRANT SELECT,INSERT,UPDATE ON firm_import_jobs TO capiro_app;
    REVOKE ALL ON firm_import_job_items FROM capiro_app;
    GRANT SELECT,INSERT,UPDATE ON firm_import_job_items TO capiro_app;
  END IF;
END $$;
