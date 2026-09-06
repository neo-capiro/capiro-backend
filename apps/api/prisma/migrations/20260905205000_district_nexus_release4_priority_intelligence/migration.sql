-- District Nexus Release 4 — Federal + Local Priority Intelligence.
--
-- Three ADDITIVE public (global) tables:
--   gsa_real_property          — FRPP detailed civilian asset facts (one row per asset).
--   gsa_real_property_source_run — per-source-run audit (dry-run aware; dry runs
--                                write run evidence but zero fact rows).
--   district_nexus_change      — deterministic public change ledger for District
--                                Nexus priority intelligence (old/new value pairs).
--
-- Global public facts: NO tenant_id, NO RLS (same posture as
-- district_economic_fact / community_funding_request). Tenant association with a
-- change happens only at read time through tenant-scoped evidence — never on the
-- public row.
--
-- Geography: every fact carries boundary_congress explicitly. CD119/CD120 can
-- never silently join: identity includes COALESCE(boundary_congress,-1), and the
-- change table carries source_geography_vintage per side.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS gsa_real_property (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Deterministic source identity. source_hash is the IDENTITY: SHA-256 over
  -- canonical JSON of (source_document_sha256, rp_uid, fiscal_year,
  -- boundary_congress, asset_status_code) where absent components are JSON
  -- null — so the hash is total (never NULL) and distinct identities always
  -- hash distinctly. UNIQUE(source_hash) therefore enforces the full identity
  -- including NULL boundary_congress / asset_status_code (a nullable column in
  -- a compound UNIQUE would treat NULLs as distinct and let duplicates past).
  -- Re-running the same document is a no-op; a corrected re-publication is a
  -- new row.
  source_hash char(64) NOT NULL,
  source_document_sha256 char(64) NOT NULL,
  source_dataset varchar(48) NOT NULL DEFAULT 'frpp_public_detailed',
  fiscal_year integer NOT NULL,
  retrieved_at timestamptz NOT NULL,
  -- Stable FRPP asset identifier (Real Property Unique Identifier) — unique only
  -- within a (fiscal_year, reporting agency) publication.
  rp_uid varchar(64) NOT NULL,
  reporting_agency text NOT NULL,
  reporting_agency_code varchar(8),
  using_agency text,
  bureau text,
  installation_name text,
  installation_id varchar(64),
  -- True when this row is a SUMMARIZED installation-level row rather than a
  -- detailed asset row. The FY24+ detailed public dataset contains no DoD rows
  -- (FASTA exclusion); if a future source mixes grains, the summarized rows are
  -- marked here so they can never double-count detailed assets.
  grain varchar(24) NOT NULL DEFAULT 'detailed_asset'
    CONSTRAINT gsa_real_property_grain_check CHECK (grain IN ('detailed_asset', 'summarized_installation')),
  -- DoD rows come from the separate summarized dataset; recorded explicitly so
  -- defense-presence context cannot silently read as detailed civilian assets.
  is_defense boolean NOT NULL DEFAULT false,
  us_or_foreign varchar(24) NOT NULL,
  country_name text,
  state_code varchar(8),
  state_name text,
  county_name text,
  city_name text,
  zip_code varchar(16),
  street_address text,
  latitude numeric(10, 7),
  longitude numeric(10, 7),
  -- Geocode provenance: the coordinates are source-supplied, never geocoded by us.
  geography_basis varchar(24) NOT NULL DEFAULT 'source_coordinates'
    CONSTRAINT gsa_real_property_geo_basis_check CHECK (geography_basis IN ('source_coordinates', 'source_state_only', 'unresolved')),
  legal_interest varchar(24),
  real_property_type text,
  real_property_use text,
  utilization text,
  asset_status text,
  asset_status_code varchar(8),
  historical_status text,
  square_feet numeric(18, 2),
  square_feet_uom varchar(16),
  congressional_district varchar(8),
  -- Boundary Congress the district attribution is expressed against. NULL means
  -- the source did not state a boundary vintage — visible, never inferred.
  boundary_congress integer,
  district_source varchar(24) NOT NULL DEFAULT 'source_reported'
    CONSTRAINT gsa_real_property_district_source_check CHECK (district_source IN ('source_reported', 'unresolved')),
  congressional_district_source_url text,
  congress_session integer,
  lease_expiration_date date,
  lease_start_date date,
  annual_rent_usd numeric(18, 2),
  federal_employees_count integer,
  federal_contractors_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gsa_real_property_identity_key UNIQUE (source_hash),
  CONSTRAINT gsa_real_property_year_check CHECK (fiscal_year BETWEEN 1900 AND 2200)
);

-- Lookup + change-detection indexes.
CREATE INDEX IF NOT EXISTS gsa_real_property_district_idx
  ON gsa_real_property (state_code, congressional_district, fiscal_year DESC);
CREATE INDEX IF NOT EXISTS gsa_real_property_rp_uid_idx
  ON gsa_real_property (rp_uid, fiscal_year DESC);
CREATE INDEX IF NOT EXISTS gsa_real_property_agency_idx
  ON gsa_real_property (reporting_agency);

-- One row per ingestion attempt against one source document. Dry runs record
-- rows_seen/validated but always rows_written = 0 (enforced below).
CREATE TABLE IF NOT EXISTS gsa_real_property_source_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_dataset varchar(48) NOT NULL,
  fiscal_year integer,
  source_document_sha256 char(64),
  source_url text,
  dry_run boolean NOT NULL DEFAULT true,
  status varchar(24) NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  rows_seen integer NOT NULL DEFAULT 0,
  rows_written integer NOT NULL DEFAULT 0,
  rows_rejected integer NOT NULL DEFAULT 0,
  rows_skipped_duplicate integer NOT NULL DEFAULT 0,
  error text,
  metadata_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT gsa_real_property_source_run_status_check CHECK (
    status IN ('running', 'success', 'success_with_errors', 'failed', 'unavailable')
  ),
  CONSTRAINT gsa_real_property_source_run_counts_check CHECK (
    rows_seen >= 0 AND rows_written >= 0 AND rows_rejected >= 0 AND rows_skipped_duplicate >= 0
  ),
  -- A dry run never writes fact rows.
  CONSTRAINT gsa_real_property_source_run_dry_run_zero_writes CHECK (
    dry_run = false OR rows_written = 0
  )
);

CREATE INDEX IF NOT EXISTS gsa_real_property_source_run_latest_idx
  ON gsa_real_property_source_run (source_dataset, attempted_at DESC);

-- ── Deterministic public change ledger ──────────────────────────────────────
-- Requires old value/state, new value/state, observed + effective timestamps,
-- source year/version, geography vintage, severity, provenance. No tenant or
-- private fields. Identity: change_kind + district + subject + source identity.
CREATE TABLE IF NOT EXISTS district_nexus_change (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key varchar(120) NOT NULL,
  change_kind varchar(48) NOT NULL
    CONSTRAINT district_nexus_change_kind_check CHECK (change_kind IN (
      'cpf_cds_request_new',
      'cpf_cds_amount_stage_correction',
      'gsa_property_added',
      'gsa_property_removed',
      'gsa_property_material_change',
      'sector_metric_material_change',
      'economic_fact_material_change'
    )),
  source varchar(32) NOT NULL,
  source_dataset varchar(64),
  source_record_id text NOT NULL,
  source_fiscal_year integer,
  source_version text,
  state_code varchar(2),
  district_code varchar(8),
  boundary_congress integer,
  member_bioguide_ids text[] NOT NULL DEFAULT '{}',
  old_value jsonb,
  new_value jsonb,
  old_state varchar(24),
  new_state varchar(24),
  observed_at timestamptz NOT NULL,
  effective_at timestamptz,
  source_year integer,
  geography_vintage varchar(48),
  severity varchar(16) NOT NULL DEFAULT 'info'
    CONSTRAINT district_nexus_change_severity_check CHECK (severity IN ('info', 'notable', 'material')),
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT district_nexus_change_identity_key UNIQUE (dedupe_key)
);

-- Plain-column form matches the Prisma model (stateCode, districtCode,
-- boundaryCongress, observedAt DESC). The reader queries (state, district)
-- ordered by observed_at; boundary_congress rides along in-index so a vintage
-- filter can be added without a second index. The COALESCE(boundary,-1) join
-- rule lives in query identity logic, not in this index.
CREATE INDEX IF NOT EXISTS district_nexus_change_district_idx
  ON district_nexus_change (state_code, district_code, boundary_congress, observed_at DESC);
CREATE INDEX IF NOT EXISTS district_nexus_change_kind_idx
  ON district_nexus_change (change_kind, observed_at DESC);

-- Severity policy is centrally versioned in code (priority-intelligence-change-policy.ts);
-- the column CHECK above is only a coarse guard. No LLM ever writes these rows:
-- the detector is deterministic, and AI may only summarize already-determined changes.

-- Materiality policy version stamp for provenance/debugging (policy rows only —
-- the policy itself lives in code so it is testable).
COMMENT ON TABLE district_nexus_change IS
  'District Nexus Release 4 deterministic public change ledger. Materiality policy version: district-nexus-change-policy-v1. Global/public: no tenant_id, no RLS; client association happens only at read time via tenant-scoped evidence.';
