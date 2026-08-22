-- District Nexus Release 3 — Economic Footprint
--
-- Three deliberately separate rails:
--   1. tenant-owned first-party import/evidence;
--   2. global public district context (ACS/CBP/LODES);
--   3. supplier/subaward facts remain owned by the existing Federal Market/Tango rail.
--
-- Public context never becomes client nexus merely because it shares a district.
-- Imported evidence never becomes score-bearing or externally usable until reviewed.
-- All additions are nullable/additive and safe for an empty first deployment.

CREATE TABLE IF NOT EXISTS client_footprint_import (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  filename text NOT NULL,
  format varchar(24) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'preview',
  source_type varchar(32) NOT NULL DEFAULT 'client_import',
  content_sha256 varchar(64),
  row_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  mapping_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  preview_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings_jsonb jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_date date,
  external_use_approved boolean NOT NULL DEFAULT false,
  created_by_user_id uuid,
  committed_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_footprint_import_format_check
    CHECK (format IN ('csv', 'xlsx', 'manual', 'meri_structured')),
  CONSTRAINT client_footprint_import_status_check
    CHECK (status IN ('preview', 'committed', 'failed', 'superseded')),
  CONSTRAINT client_footprint_import_counts_check
    CHECK (row_count >= 0 AND accepted_count >= 0 AND rejected_count >= 0),
  CONSTRAINT client_footprint_import_external_use_check
    CHECK (external_use_approved = false)
);

CREATE INDEX IF NOT EXISTS client_footprint_import_tenant_client_created_idx
  ON client_footprint_import (tenant_id, client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS client_footprint_import_tenant_status_idx
  ON client_footprint_import (tenant_id, status, created_at DESC);
-- A file may be previewed repeatedly, but it may establish evidence only once
-- for one client. The transaction rolls back its evidence inserts if this
-- final committed-state transition conflicts.
CREATE UNIQUE INDEX IF NOT EXISTS client_footprint_import_committed_content_uniq
  ON client_footprint_import (tenant_id, client_id, content_sha256)
  WHERE content_sha256 IS NOT NULL AND status = 'committed';

CREATE TABLE IF NOT EXISTS client_geographic_evidence (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  import_id uuid REFERENCES client_footprint_import(id) ON DELETE SET NULL,
  row_ordinal integer,
  evidence_type varchar(32) NOT NULL,
  subject_type varchar(32),
  subject_id text,
  subject_name text,
  address_line1 text,
  address_line2 text,
  city text,
  state varchar(2),
  postal_code varchar(16),
  country varchar(2) NOT NULL DEFAULT 'US',
  latitude double precision,
  longitude double precision,
  congressional_district varchar(8),
  congressional_district_congress integer,
  district_source varchar(24),
  numeric_value numeric(18,2),
  unit varchar(32),
  currency varchar(3),
  source_type varchar(32) NOT NULL DEFAULT 'client_import',
  source_document_id uuid,
  source_record_id text,
  verification_status varchar(24) NOT NULL DEFAULT 'user_provided',
  review_status varchar(24) NOT NULL DEFAULT 'pending_review',
  confidence numeric(5,4),
  external_use_approved boolean NOT NULL DEFAULT false,
  effective_from date,
  effective_to date,
  observed_at timestamptz,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  promoted_facility_id uuid REFERENCES client_facilities(id) ON DELETE SET NULL,
  created_by_user_id uuid,
  reviewed_by_user_id uuid,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_geographic_evidence_type_check CHECK (
    evidence_type IN (
      'facility', 'employee', 'payroll', 'capital_investment', 'taxes',
      'supplier', 'supplier_spend', 'partner', 'beneficiary',
      'beneficiary_count', 'project_site', 'other'
    )
  ),
  CONSTRAINT client_geographic_evidence_verification_check CHECK (
    verification_status IN ('source_verified', 'geocode_verified', 'user_provided', 'inferred')
  ),
  CONSTRAINT client_geographic_evidence_review_check CHECK (
    review_status IN ('pending_review', 'approved', 'rejected')
  ),
  CONSTRAINT client_geographic_evidence_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT client_geographic_evidence_dates_check CHECK (
    effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT client_geographic_evidence_external_use_check CHECK (
    external_use_approved = false OR review_status = 'approved'
  )
);

CREATE INDEX IF NOT EXISTS client_geographic_evidence_tenant_client_district_idx
  ON client_geographic_evidence (
    tenant_id, client_id, state, congressional_district, review_status
  );
CREATE INDEX IF NOT EXISTS client_geographic_evidence_tenant_client_type_idx
  ON client_geographic_evidence (tenant_id, client_id, evidence_type, review_status);
CREATE INDEX IF NOT EXISTS client_geographic_evidence_import_idx
  ON client_geographic_evidence (tenant_id, import_id, row_ordinal);
CREATE INDEX IF NOT EXISTS client_geographic_evidence_facility_promotion_idx
  ON client_geographic_evidence (tenant_id, promoted_facility_id)
  WHERE promoted_facility_id IS NOT NULL;

-- Defense in depth for any future writer that does not use the Release 3
-- service. A reviewed decision is terminal because approved facility evidence
-- may already have been promoted into the canonical client_facilities rail.
CREATE OR REPLACE FUNCTION enforce_client_geographic_evidence_review()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.review_status IN ('approved', 'rejected')
     AND NEW.review_status IS DISTINCT FROM OLD.review_status THEN
    RAISE EXCEPTION 'client geographic evidence review is final'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.review_status <> 'approved' THEN
    NEW.external_use_approved := false;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_geographic_evidence_review_guard
  ON client_geographic_evidence;
CREATE TRIGGER client_geographic_evidence_review_guard
BEFORE INSERT OR UPDATE ON client_geographic_evidence
FOR EACH ROW EXECUTE FUNCTION enforce_client_geographic_evidence_review();

-- Public, global, geography-versioned facts. No tenant_id by design.
CREATE TABLE IF NOT EXISTS district_economic_fact (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source varchar(24) NOT NULL,
  dataset varchar(64) NOT NULL,
  source_year integer NOT NULL,
  geography_type varchar(32) NOT NULL DEFAULT 'congressional_district',
  state varchar(2) NOT NULL,
  district_code varchar(8) NOT NULL,
  boundary_congress integer,
  metric_key varchar(96) NOT NULL,
  metric_value numeric(24,6),
  unit varchar(32),
  margin_of_error numeric(24,6),
  naics_code varchar(16),
  source_record_id text,
  source_url text,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz,
  last_synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT district_economic_fact_source_check CHECK (source IN ('acs', 'cbp', 'lodes')),
  CONSTRAINT district_economic_fact_geo_check CHECK (geography_type = 'congressional_district')
);

CREATE UNIQUE INDEX IF NOT EXISTS district_economic_fact_identity_idx
  ON district_economic_fact (
    source, dataset, source_year, state, district_code,
    COALESCE(boundary_congress, -1), metric_key, COALESCE(naics_code, '')
  );
CREATE INDEX IF NOT EXISTS district_economic_fact_district_idx
  ON district_economic_fact (state, district_code, source_year DESC, source, metric_key);
CREATE INDEX IF NOT EXISTS district_economic_fact_naics_idx
  ON district_economic_fact (naics_code, source_year DESC)
  WHERE naics_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS district_economic_source_run (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  source varchar(24) NOT NULL,
  dataset varchar(64) NOT NULL,
  source_year integer,
  boundary_congress integer,
  status varchar(24) NOT NULL,
  dry_run boolean NOT NULL DEFAULT true,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rows_seen integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  cursor_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT district_economic_source_run_source_check CHECK (source IN ('acs', 'cbp', 'lodes')),
  CONSTRAINT district_economic_source_run_status_check CHECK (
    status IN ('running', 'success', 'success_with_errors', 'failed', 'unavailable')
  ),
  CONSTRAINT district_economic_source_run_counts_check CHECK (
    rows_seen >= 0 AND rows_written >= 0 AND rows_rejected >= 0
  )
);

CREATE INDEX IF NOT EXISTS district_economic_source_run_latest_idx
  ON district_economic_source_run (source, dataset, attempted_at DESC);

ALTER TABLE client_footprint_import ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_footprint_import FORCE ROW LEVEL SECURITY;
ALTER TABLE client_geographic_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_geographic_evidence FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS client_footprint_import_tenant_policy ON client_footprint_import;
CREATE POLICY client_footprint_import_tenant_policy ON client_footprint_import
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

DROP POLICY IF EXISTS client_geographic_evidence_tenant_policy ON client_geographic_evidence;
CREATE POLICY client_geographic_evidence_tenant_policy ON client_geographic_evidence
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

COMMENT ON TABLE client_footprint_import IS
  'Release 3: reviewable first-party economic-footprint imports. Preview never changes scores.';
COMMENT ON TABLE client_geographic_evidence IS
  'Release 3: source/effective-date/verification-aware client geographic evidence.';
COMMENT ON TABLE district_economic_fact IS
  'Release 3: public ACS/CBP/LODES district context; never client nexus by itself.';
