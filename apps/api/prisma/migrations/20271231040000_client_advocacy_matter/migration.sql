-- Advocacy Matter: the grouping abstraction over Advocacy History.
--
-- PR #1246 shipped the durable per-item advocacy record (LDA filings, client
-- submissions, private meeting/email candidates unified in
-- client_advocacy_record) plus lifecycle/outcome linking. What it did not
-- ship is the thing the product spec actually asks for: a coherent
-- institutional history grouped by "what this client is advocating for"
-- (an Advocacy Matter) rather than a flat per-source timeline.
--
-- client_advocacy_matter is the Matter. client_advocacy_record gets a
-- nullable matter_id (a record belongs to at most one matter — the common,
-- fast-joined case). client_advocacy_matter_link is a lightweight typed
-- join for everything that is NOT itself a client_advocacy_record row but
-- still belongs to the Matter's institutional history: Program Elements,
-- bills, and outcome events. Meetings/emails/outreach already flow into
-- client_advocacy_record via gatherPrivateAdvocacyCandidates, so they roll
-- up into a Matter transitively through matter_id — no separate link type
-- needed for those.

CREATE TABLE IF NOT EXISTS client_advocacy_matter (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  matter_type VARCHAR(32) NOT NULL DEFAULT 'other',
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  summary TEXT NULL,
  primary_pe_code VARCHAR(16) NULL,
  primary_bill_id TEXT NULL,
  -- Deterministic clustering key (e.g. "pe:0605053A", "bill:119-hr-1234",
  -- "issue:LOB+2027", "manual:<uuid>"). Auto-generated matters are found by
  -- this key before a new one is created; manually created matters get a
  -- generated uuid-based key so they never collide with an auto key.
  external_key VARCHAR(300) NOT NULL,
  auto_generated BOOLEAN NOT NULL DEFAULT true,
  opened_at TIMESTAMPTZ NULL,
  last_activity_at TIMESTAMPTZ NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_advocacy_matter_type_check CHECK (matter_type IN (
    'funding_request', 'legislative', 'regulatory', 'program_element',
    'community_project', 'procurement', 'other'
  )),
  CONSTRAINT client_advocacy_matter_status_check CHECK (status IN (
    'open', 'monitoring', 'resolved', 'stalled'
  )),
  CONSTRAINT client_advocacy_matter_external_uniq UNIQUE (tenant_id, client_id, external_key)
);

CREATE INDEX IF NOT EXISTS client_advocacy_matter_client_activity_idx
  ON client_advocacy_matter (tenant_id, client_id, last_activity_at DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS client_advocacy_matter_status_idx
  ON client_advocacy_matter (tenant_id, client_id, status);

ALTER TABLE client_advocacy_record
  ADD COLUMN IF NOT EXISTS matter_id UUID NULL REFERENCES client_advocacy_matter(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS client_advocacy_record_matter_idx
  ON client_advocacy_record (tenant_id, matter_id);

CREATE TABLE IF NOT EXISTS client_advocacy_matter_link (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  matter_id UUID NOT NULL REFERENCES client_advocacy_matter(id) ON DELETE CASCADE,
  -- program_element: link_key = pe_code. bill: link_key = congress_bill.id.
  -- outcome_event: link_key = outcome_event.id (uuid text). finding: link_key
  -- = client_profile_fill_finding.id (uuid text), used for still-pending
  -- program_element/bill_recommendation findings before they graduate into a
  -- durable row of their own.
  link_type VARCHAR(32) NOT NULL,
  link_key VARCHAR(300) NOT NULL,
  label TEXT NULL,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by_user_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT client_advocacy_matter_link_type_check CHECK (link_type IN (
    'program_element', 'bill', 'outcome_event', 'finding'
  )),
  CONSTRAINT client_advocacy_matter_link_uniq UNIQUE (matter_id, link_type, link_key)
);

CREATE INDEX IF NOT EXISTS client_advocacy_matter_link_matter_idx
  ON client_advocacy_matter_link (tenant_id, matter_id);
CREATE INDEX IF NOT EXISTS client_advocacy_matter_link_lookup_idx
  ON client_advocacy_matter_link (tenant_id, link_type, link_key);

ALTER TABLE client_advocacy_matter ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_advocacy_matter FORCE ROW LEVEL SECURITY;
ALTER TABLE client_advocacy_matter_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_advocacy_matter_link FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'client_advocacy_matter',
    'client_advocacy_matter_link'
  ]
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_select',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name || '_select',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_insert',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name || '_insert',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_update',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE USING (rls_bypass() OR tenant_id = current_tenant_id()) WITH CHECK (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name || '_update',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      table_name || '_delete',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR DELETE USING (rls_bypass() OR tenant_id = current_tenant_id())',
      table_name || '_delete',
      table_name
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_advocacy_matter TO capiro_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON client_advocacy_matter_link TO capiro_app;
  END IF;
END $$;
