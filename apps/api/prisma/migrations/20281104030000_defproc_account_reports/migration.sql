-- Release 1: USAspending account report observation layer.
-- append-only table, closed writer, closed reader, REVOKE public access.
-- Migration ID 20281104030000 follows repository chronology (not wall-clock date).
-- Requires: defproc_v2_private schema and helpers (valid_award_key, instant, utc, money).
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF current_user<>'capiro_master' THEN RAISE EXCEPTION 'DEFPROC_MIGRATION_OWNER_REQUIRED'; END IF;
 -- Require the v2 private schema helpers.
 IF to_regprocedure('defproc_v2_private.valid_award_key(text)') IS NULL
 OR to_regprocedure('defproc_v2_private.instant(text)') IS NULL
 OR to_regprocedure('defproc_v2_private.utc(timestamptz)') IS NULL
 OR to_regprocedure('defproc_v2_private.money(jsonb)') IS NULL
 THEN RAISE EXCEPTION 'DEFPROC_V2_PRIVATE_HELPERS_REQUIRED'; END IF;
 -- Require the existing job roles.
 IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='capiro_defense_job')
 OR NOT EXISTS(SELECT FROM pg_roles WHERE rolname='capiro_app')
 THEN RAISE EXCEPTION 'DEFPROC_ROLES_REQUIRED'; END IF;
 -- Not already present.
 IF to_regclass('public.defproc_account_report_observation_v1') IS NOT NULL
 OR to_regprocedure('public.defproc_append_account_report_v1(text,text,text,text)') IS NOT NULL
 OR to_regprocedure('public.defproc_account_reports_scope_v1(text[],text)') IS NOT NULL
 THEN RAISE EXCEPTION 'DEFPROC_ACCOUNT_REPORTS_ALREADY_PRESENT'; END IF;
END $$;

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE public.defproc_account_report_observation_v1 (
 id uuid NOT NULL DEFAULT gen_random_uuid(),
 award_key text NOT NULL,
 source_observed_at timestamptz NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 raw_response text NOT NULL,
 response_sha256 text NOT NULL,
 request_award_id text NOT NULL,
 CONSTRAINT defproc_account_report_observation_v1_pkey PRIMARY KEY (id),
 CONSTRAINT defproc_account_report_observation_v1_unique UNIQUE (award_key, source_observed_at),
 CONSTRAINT defproc_account_report_observation_v1_award_key_valid
  CHECK (defproc_v2_private.valid_award_key(award_key)),
 CONSTRAINT defproc_account_report_observation_v1_sha256_valid
  CHECK (response_sha256 ~ '^[a-f0-9]{64}$'),
 CONSTRAINT defproc_account_report_observation_v1_raw_nonempty
  CHECK (length(raw_response) > 0),
 CONSTRAINT defproc_account_report_observation_v1_raw_utf8_size
  CHECK (octet_length(convert_to(raw_response,'UTF8')) <= 1048576),
 CONSTRAINT defproc_account_report_observation_v1_sha256_match
  CHECK (encode(sha256(convert_to(raw_response,'UTF8')),'hex') = response_sha256)
);

-- Block update/delete/truncate. App may not write.
CREATE TRIGGER defproc_account_report_observation_v1_no_update
 BEFORE UPDATE ON public.defproc_account_report_observation_v1
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();
CREATE TRIGGER defproc_account_report_observation_v1_no_delete
 BEFORE DELETE ON public.defproc_account_report_observation_v1
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();
CREATE TRIGGER defproc_account_report_observation_v1_no_truncate
 BEFORE TRUNCATE ON public.defproc_account_report_observation_v1
 FOR EACH STATEMENT EXECUTE FUNCTION defproc_v2_private.immutable();

-- Revoke all public and existing grantee access to the raw table.
-- Preserve the table owner's ACL explicitly before revoking non-owner grantees.
DO $$
DECLARE a record; obj text; grantee text; owner_name text;
BEGIN
 obj:='public.defproc_account_report_observation_v1';
 -- Capture owner name for explicit re-grant after revoke.
 SELECT pg_get_userbyid(c.relowner) INTO owner_name
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname='defproc_account_report_observation_v1';
 EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC',obj);
 -- Revoke non-owner grantees only (grantee<>0 AND grantee<>owner oid).
 FOR a IN SELECT DISTINCT e.grantee FROM
  aclexplode(coalesce(
   (SELECT relacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='defproc_account_report_observation_v1'),
   acldefault('r',(SELECT relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='defproc_account_report_observation_v1')))) e
  WHERE e.grantee<>0
    AND e.grantee<>(SELECT relowner FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE n.nspname='public' AND c.relname='defproc_account_report_observation_v1')
 LOOP
  grantee:=pg_get_userbyid(a.grantee);
  EXECUTE format('REVOKE ALL ON TABLE %s FROM %I',obj,grantee);
 END LOOP;
 -- Restore owner SELECT/INSERT explicitly (owner may have lost rights via PUBLIC revoke).
 IF owner_name IS NOT NULL THEN
  EXECUTE format('GRANT SELECT,INSERT ON TABLE %s TO %I',obj,owner_name);
 END IF;
END $$;

-- ── Append function ───────────────────────────────────────────────────────────

-- public.defproc_append_account_report_v1(award_key, observed_at_utc6, raw_body, sha256)
-- Returns JSON {snapshotId, inserted}
-- SECURITY DEFINER: only defense job roles may execute; app cannot write.
CREATE FUNCTION public.defproc_append_account_report_v1(
 p_award_key text,
 p_observed_at text,
 p_raw_body text,
 p_sha256 text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_observed_at timestamptz;
 v_existing uuid;
 v_id uuid;
 v_utc text;
 -- JSON validation variables.
 v_body jsonb;
 v_results jsonb;
 v_meta jsonb;
 v_row jsonb;
 v_field text;
 v_val jsonb;
 v_kind text;
 v_n numeric;
BEGIN
 -- Validate award key.
 IF p_award_key IS NULL OR NOT defproc_v2_private.valid_award_key(p_award_key)
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid award key'; END IF;
 -- Validate observed_at: exact UTC6 microsecond string.
 v_observed_at := defproc_v2_private.instant(p_observed_at);
 IF v_observed_at IS NULL OR NOT isfinite(v_observed_at)
  OR defproc_v2_private.utc(v_observed_at) <> p_observed_at
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid exact UTC6 observed_at'; END IF;
 -- Validate SHA256 format.
 IF p_sha256 IS NULL OR p_sha256 !~ '^[a-f0-9]{64}$'
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid SHA256'; END IF;
 -- Validate body is non-empty, <=1MiB UTF-8, and hash matches.
 IF p_raw_body IS NULL OR length(p_raw_body) = 0
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Empty raw body'; END IF;
 IF octet_length(convert_to(p_raw_body,'UTF8')) > 1048576
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Raw body exceeds 1 MiB'; END IF;
 IF encode(sha256(convert_to(p_raw_body,'UTF8')),'hex') <> p_sha256
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='SHA256 mismatch'; END IF;
 -- Validate structure and original field types before admitting immutable evidence.
 BEGIN
  v_body := p_raw_body::jsonb;
 EXCEPTION WHEN data_exception THEN
  RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Body is not valid JSON';
 END;
 v_results := v_body->'results';
 v_meta := v_body->'page_metadata';
 IF jsonb_typeof(v_body) IS DISTINCT FROM 'object'
  OR jsonb_typeof(v_results) IS DISTINCT FROM 'array'
  OR jsonb_typeof(v_meta) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid account response structure'; END IF;
 IF (v_meta @> '{"page":1,"hasNext":false,"next":null,"hasPrevious":false,"previous":null}'::jsonb) IS NOT TRUE
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Complete single page metadata required'; END IF;
 IF jsonb_array_length(v_results)>100
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Results exceed 100 rows'; END IF;
 FOR v_row IN SELECT value FROM jsonb_array_elements(v_results) LOOP
  IF jsonb_typeof(v_row) IS DISTINCT FROM 'object'
  THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Account row must be an object'; END IF;
  FOREACH v_field IN ARRAY ARRAY['federal_account','account_title','program_activity_code','program_activity_name',
   'object_class','object_class_name','disaster_emergency_fund_code','funding_agency_name','awarding_agency_name',
   'reporting_fiscal_year','reporting_fiscal_quarter','reporting_fiscal_month','is_quarterly_submission',
   'transaction_obligated_amount','gross_outlay_amount'] LOOP
   IF NOT(v_row ? v_field)
   THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Missing required account row field'; END IF;
   v_val:=v_row->v_field;
   v_kind:=jsonb_typeof(v_val);
   IF v_kind='null' THEN CONTINUE; END IF;
   IF v_field IN ('transaction_obligated_amount','gross_outlay_amount') THEN
    IF v_kind<>'number' OR (v_row->>v_field) !~ '^-?[0-9]{1,128}(\.[0-9]{1,128})?$'
    THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Account money must be an exact bounded JSON number or null'; END IF;
   ELSIF v_field IN ('reporting_fiscal_year','reporting_fiscal_quarter','reporting_fiscal_month') THEN
    IF v_kind<>'number' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid reporting period type'; END IF;
    v_n:=(v_row->>v_field)::numeric;
    IF v_n<>trunc(v_n) OR (v_field='reporting_fiscal_year' AND v_n NOT BETWEEN 1900 AND 9999)
     OR (v_field='reporting_fiscal_quarter' AND v_n NOT BETWEEN 1 AND 4)
     OR (v_field='reporting_fiscal_month' AND v_n NOT BETWEEN 1 AND 12)
    THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid reporting period value'; END IF;
   ELSIF v_field='is_quarterly_submission' THEN
    IF v_kind<>'boolean' THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid submission mode'; END IF;
   ELSIF v_kind<>'string' OR octet_length(convert_to(v_row->>v_field,'UTF8'))>4096
    OR (v_row->>v_field) ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']') THEN
    RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid account text field';
   END IF;
  END LOOP;
 END LOOP;
 -- Concurrent-safe append: use ON CONFLICT DO NOTHING to avoid exact-replay race.
 -- If conflict occurs, verify bytes are identical; changed bytes same clock must refuse.
 INSERT INTO public.defproc_account_report_observation_v1
  (award_key, source_observed_at, recorded_at, raw_response, response_sha256, request_award_id)
 VALUES (p_award_key, v_observed_at, statement_timestamp(), p_raw_body, p_sha256,
  substr(p_award_key, 19)) -- strip 'usaspending|award|' prefix
 ON CONFLICT (award_key, source_observed_at) DO NOTHING
 RETURNING id INTO v_id;
 IF v_id IS NULL THEN
  -- Row already exists. Verify exact byte match; changed bytes at same clock must refuse.
  SELECT id INTO v_existing
  FROM public.defproc_account_report_observation_v1
  WHERE award_key = p_award_key AND source_observed_at = v_observed_at;
  IF (SELECT response_sha256 FROM public.defproc_account_report_observation_v1 WHERE id=v_existing) IS DISTINCT FROM p_sha256
  THEN RAISE EXCEPTION USING ERRCODE='23505', MESSAGE='Changed observation at same instant refused'; END IF;
  RETURN jsonb_build_object('snapshotId', v_existing::text, 'inserted', false);
 END IF;
 RETURN jsonb_build_object('snapshotId', v_id::text, 'inserted', true);
END $$;

-- Only defense job roles may write. App cannot write.
REVOKE ALL ON FUNCTION public.defproc_append_account_report_v1(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.defproc_append_account_report_v1(text,text,text,text)
 TO capiro_defense_job;

-- ── Scope reader ──────────────────────────────────────────────────────────────

-- public.defproc_account_reports_scope_v1(award_keys text[], known_at_utc6 text)
-- Returns the frozen ProcurementAccountReports contract as jsonb.
-- knownAt selects recorded_at <= boundary; tied latest different observations → conflict.
-- Missing observation → unavailable (not invented empty).
-- Entire response UTF8 <=1MiB; refuses with 22023 if exceeded.
CREATE FUNCTION public.defproc_account_reports_scope_v1(
 p_award_keys text[],
 p_known_at text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE
 v_known_at timestamptz;
 v_known_at_utc text;
 v_result jsonb;
 v_result_size bigint;
BEGIN
 -- Validate award keys array: 1-25 distinct valid keys.
 IF p_award_keys IS NULL OR cardinality(p_award_keys) NOT BETWEEN 1 AND 25
  OR array_ndims(p_award_keys) <> 1
  OR EXISTS(SELECT FROM unnest(p_award_keys) k WHERE k IS NULL OR length(k) > 512
   OR NOT defproc_v2_private.valid_award_key(k))
  OR (SELECT count(DISTINCT k) FROM unnest(p_award_keys) k) <> cardinality(p_award_keys)
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid finite canonical award scope'; END IF;
 -- Validate known_at: exact UTC6 microsecond string or NULL.
 IF p_known_at IS NULL THEN
  v_known_at := statement_timestamp();
  v_known_at_utc := defproc_v2_private.utc(v_known_at);
 ELSE
  v_known_at := defproc_v2_private.instant(p_known_at);
  IF v_known_at IS NULL OR NOT isfinite(v_known_at) OR v_known_at > statement_timestamp()
   OR defproc_v2_private.utc(v_known_at) <> p_known_at
  THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid exact UTC6 known_at clock'; END IF;
  v_known_at_utc := p_known_at;
 END IF;

 WITH
 -- All observations for the requested awards recorded at or before known_at.
 eligible AS MATERIALIZED (
  SELECT id, award_key, source_observed_at, recorded_at, response_sha256, raw_response, request_award_id
  FROM public.defproc_account_report_observation_v1
  WHERE award_key = ANY(p_award_keys)
    AND recorded_at <= v_known_at
 ),
 -- For each award: the latest recorded_at. Multiple rows at the same latest instant = conflict.
 latest_per_award AS MATERIALIZED (
  SELECT award_key, max(recorded_at) AS max_recorded_at
  FROM eligible
  GROUP BY award_key
 ),
 -- Detect conflict: more than one distinct source_observed_at at the latest recorded_at.
 conflict_awards AS (
  SELECT e.award_key
  FROM eligible e
  JOIN latest_per_award l ON l.award_key = e.award_key AND l.max_recorded_at = e.recorded_at
  GROUP BY e.award_key
  HAVING count(DISTINCT e.response_sha256) > 1
 ),
 -- The single canonical snapshot for non-conflict awards.
 canonical AS MATERIALIZED (
  SELECT DISTINCT ON (e.award_key) e.id, e.award_key, e.source_observed_at, e.recorded_at, e.response_sha256, e.raw_response, e.request_award_id
  FROM eligible e
  JOIN latest_per_award l ON l.award_key = e.award_key AND l.max_recorded_at = e.recorded_at
  LEFT JOIN conflict_awards c ON c.award_key = e.award_key
  WHERE c.award_key IS NULL
  ORDER BY e.award_key,e.source_observed_at DESC,e.id
 ),
 -- Build one report per requested award.
 reports AS (
  SELECT
   k.award_key,
   CASE
    WHEN cf.award_key IS NOT NULL THEN 'conflict'
    WHEN cn.id IS NULL THEN 'unavailable'
    ELSE 'reported'
   END AS state,
   cn.id AS snapshot_id,
   cn.source_observed_at,
   cn.recorded_at,
   cn.response_sha256,
   cn.raw_response,
   cn.request_award_id
  FROM unnest(p_award_keys) AS k(award_key)
  LEFT JOIN conflict_awards cf ON cf.award_key = k.award_key
  LEFT JOIN canonical cn ON cn.award_key = k.award_key
 ),
 -- Project rows for 'reported' awards from JSONB numeric values without IEEE loss.
 -- Monetary fields use defproc_v2_private.money() for exact numeric→text, preserving null/negative.
 row_projections AS (
  SELECT
   r.award_key,
   (idx - 1) AS source_row_index,
   result_row->>'federal_account' AS federal_account,
   result_row->>'account_title' AS account_title,
   CASE WHEN jsonb_typeof(result_row->'transaction_obligated_amount') = 'null'
        OR result_row->'transaction_obligated_amount' IS NULL THEN NULL
        WHEN jsonb_typeof(result_row->'transaction_obligated_amount') = 'number'
        THEN (result_row->>'transaction_obligated_amount')
        WHEN jsonb_typeof(result_row->'transaction_obligated_amount') = 'string'
        THEN (defproc_v2_private.money(result_row->'transaction_obligated_amount'))::text
   END AS reported_obligation_usd,
   CASE WHEN jsonb_typeof(result_row->'gross_outlay_amount') = 'null'
        OR result_row->'gross_outlay_amount' IS NULL THEN NULL
        WHEN jsonb_typeof(result_row->'gross_outlay_amount') = 'number'
        THEN (result_row->>'gross_outlay_amount')
        WHEN jsonb_typeof(result_row->'gross_outlay_amount') = 'string'
        THEN (defproc_v2_private.money(result_row->'gross_outlay_amount'))::text
   END AS reported_gross_outlay_usd,
   result_row->>'program_activity_code' AS program_activity_code,
   result_row->>'program_activity_name' AS program_activity_name,
   result_row->>'object_class' AS object_class,
   result_row->>'object_class_name' AS object_class_name,
   -- disaster_emergency_fund_code: always string (documentation typo says boolean; actual source is string).
   CASE WHEN jsonb_typeof(result_row->'disaster_emergency_fund_code') = 'string'
        THEN result_row->>'disaster_emergency_fund_code' END AS disaster_emergency_fund_code,
   result_row->>'funding_agency_name' AS funding_agency_name,
   result_row->>'awarding_agency_name' AS awarding_agency_name,
   CASE WHEN jsonb_typeof(result_row->'reporting_fiscal_year') = 'number'
        THEN ((result_row->>'reporting_fiscal_year')::numeric)::int END AS reporting_fiscal_year,
   CASE WHEN jsonb_typeof(result_row->'reporting_fiscal_quarter') = 'number'
        THEN ((result_row->>'reporting_fiscal_quarter')::numeric)::int END AS reporting_fiscal_quarter,
   CASE WHEN jsonb_typeof(result_row->'reporting_fiscal_month') = 'number'
        THEN ((result_row->>'reporting_fiscal_month')::numeric)::int END AS reporting_fiscal_month,
   CASE WHEN jsonb_typeof(result_row->'is_quarterly_submission') = 'boolean'
        THEN (result_row->>'is_quarterly_submission')::boolean END AS is_quarterly_submission
  FROM reports r,
   jsonb_array_elements(
    CASE WHEN r.state = 'reported' AND r.raw_response IS NOT NULL
     THEN (r.raw_response::jsonb)->'results' ELSE '[]'::jsonb END
   ) WITH ORDINALITY AS t(result_row, idx)
  WHERE r.state = 'reported'
 ),
 -- Aggregate rows per award.
 rows_by_award AS (
  SELECT
   award_key,
   jsonb_agg(
    jsonb_build_object(
     'sourceRowIndex', source_row_index,
     'federalAccount', federal_account,
     'accountTitle', account_title,
     'treasuryAccountSymbol', NULL,
     'programActivityCode', program_activity_code,
     'programActivityName', program_activity_name,
     'objectClass', object_class,
     'objectClassName', object_class_name,
     'disasterEmergencyFundCode', disaster_emergency_fund_code,
     'fundingAgencyName', funding_agency_name,
     'awardingAgencyName', awarding_agency_name,
     'reportingFiscalYear', reporting_fiscal_year,
     'reportingFiscalQuarter', reporting_fiscal_quarter,
     'reportingFiscalMonth', reporting_fiscal_month,
     'isQuarterlySubmission', is_quarterly_submission,
     'reportedObligationUsd', reported_obligation_usd,
     'reportedGrossOutlayUsd', reported_gross_outlay_usd
    ) ORDER BY source_row_index
   ) AS rows_json
  FROM row_projections
  GROUP BY award_key
 )
 SELECT jsonb_build_object(
  'contract', 'defproc-account-reports/v1',
  'knownAt', v_known_at_utc,
  'scope', jsonb_build_object(
   'awardIdentityKeys', to_jsonb(p_award_keys),
   'includesDescendants', false
  ),
  'coverage', 'source_reported_rows_only',
  'reports', (
   SELECT jsonb_agg(
    jsonb_build_object(
     'awardIdentityKey', r.award_key,
     'state', r.state,
     'snapshotId', r.snapshot_id::text,
     'sourceObservedAt', defproc_v2_private.utc(r.source_observed_at),
     'recordedAt', defproc_v2_private.utc(r.recorded_at),
     'sourcePayloadSha256', r.response_sha256,
     'sourceUrl', 'https://www.usaspending.gov/award/' || substr(r.award_key, 19),
     'rows', coalesce(rba.rows_json, '[]'::jsonb)
    ) ORDER BY r.award_key
   ) FROM reports r LEFT JOIN rows_by_award rba ON rba.award_key = r.award_key
  )
 ) INTO v_result;

 -- Size guard: entire UTF8 response <=1MiB; resource-limit refusal (54000), no truncation.
 v_result_size := octet_length(convert_to(v_result::text,'UTF8'));
 IF v_result_size > 1048576 THEN
  RAISE EXCEPTION USING ERRCODE='54000',
   MESSAGE=format('Account report response exceeds 1 MiB: %s bytes', v_result_size);
 END IF;

 RETURN v_result;
END $$;

-- Only app/approved serve roles get EXECUTE; no raw access.
REVOKE ALL ON FUNCTION public.defproc_account_reports_scope_v1(text[],text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.defproc_account_reports_scope_v1(text[],text) TO capiro_app;

COMMIT;
