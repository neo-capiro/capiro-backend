-- REVIEW CANDIDATE ONLY. Install with a dedicated authorized recovery owner.
-- Never grant this schema/function to ordinary application or worker roles.
-- The caller must supply an owner-approved exact tenant and row denominator.
BEGIN;
CREATE SCHEMA capiro_incident_recovery;
REVOKE ALL ON SCHEMA capiro_incident_recovery FROM PUBLIC, capiro_app, capiro_worker;

CREATE TABLE capiro_incident_recovery.dedup_runs (
  run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  approval_reference text NOT NULL,
  expected_visible_rows bigint NOT NULL CHECK(expected_visible_rows>=0),
  expected_candidate_ids uuid[] NOT NULL,
  expected_candidate_fingerprint text NOT NULL,
  visible_rows_after bigint NOT NULL,
  deleted_rows bigint NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE capiro_incident_recovery.dedup_rows (
  run_id uuid NOT NULL REFERENCES capiro_incident_recovery.dedup_runs(run_id),
  tenant_id uuid NOT NULL,
  row_id uuid NOT NULL,
  keeper_id uuid NOT NULL,
  original_row jsonb NOT NULL,
  PRIMARY KEY(run_id,row_id)
);
REVOKE ALL ON capiro_incident_recovery.dedup_runs, capiro_incident_recovery.dedup_rows FROM PUBLIC, capiro_app, capiro_worker;
ALTER TABLE capiro_incident_recovery.dedup_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE capiro_incident_recovery.dedup_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE capiro_incident_recovery.dedup_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE capiro_incident_recovery.dedup_rows FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON capiro_incident_recovery.dedup_runs
 USING(tenant_id=nullif(current_setting('app.current_tenant',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.current_tenant',true),'')::uuid);
CREATE POLICY tenant_scope ON capiro_incident_recovery.dedup_rows
 USING(tenant_id=nullif(current_setting('app.current_tenant',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.current_tenant',true),'')::uuid);

CREATE FUNCTION capiro_incident_recovery.deduplicate_mapping(
  p_run uuid, p_tenant uuid, p_approval_reference text,
  p_expected_rows bigint, p_expected_ids uuid[], p_expected_fingerprint text
) RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,public,capiro_incident_recovery
AS $repair$
DECLARE
  visible_rows bigint;
  candidate_ids uuid[];
  fingerprint text;
  actual_deleted bigint;
  backed_up bigint;
  survivors_before text;
  survivors_after text;
BEGIN
  IF current_user IN ('capiro_app','capiro_worker')
     OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
     OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='rds_superuser' AND pg_has_role(current_user,oid,'MEMBER')) THEN
    RAISE EXCEPTION 'Use an authorized non-bypass recovery owner';
  END IF;
  IF p_run IS NULL OR p_tenant IS NULL OR p_expected_rows IS NULL OR p_expected_rows<0
     OR p_expected_ids IS NULL OR array_position(p_expected_ids,NULL) IS NOT NULL
     OR p_expected_fingerprint IS NULL OR p_expected_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_approval_reference IS NULL OR length(btrim(p_approval_reference))<8 THEN
    RAISE EXCEPTION 'Complete approved denominator and approval reference required';
  END IF;
  IF nullif(current_setting('app.current_tenant',true),'')::uuid IS DISTINCT FROM p_tenant
     OR coalesce(nullif(current_setting('app.bypass_rls',true),''),'false')::boolean THEN
    RAISE EXCEPTION 'Exact tenant context and disabled RLS bypass required';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_class WHERE oid='public.client_intel_mapping'::regclass AND relrowsecurity AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'Forced tenant RLS required';
  END IF;
  -- Blocks inserts/updates/deletes and competing maintenance until transaction end.
  LOCK TABLE public.client_intel_mapping IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO visible_rows FROM public.client_intel_mapping;
  IF EXISTS(SELECT 1 FROM public.client_intel_mapping WHERE tenant_id IS DISTINCT FROM p_tenant) THEN
    RAISE EXCEPTION 'Tenant visibility exceeds approved scope';
  END IF;
  WITH ranked AS (
    SELECT m.id,to_jsonb(m) AS original_row,
      row_number() OVER(PARTITION BY m.tenant_id,m.client_id,m.source,m.external_id ORDER BY m.id) AS rn
    FROM public.client_intel_mapping m
  )
  SELECT coalesce(array_agg(id ORDER BY id),'{}'::uuid[]),
    encode(public.digest(coalesce(jsonb_agg(original_row ORDER BY id),'[]'::jsonb)::text,'sha256'),'hex')
  INTO candidate_ids,fingerprint FROM ranked WHERE rn>1;
  IF visible_rows<>p_expected_rows OR candidate_ids IS DISTINCT FROM p_expected_ids
     OR fingerprint<>p_expected_fingerprint THEN
    RAISE EXCEPTION 'Approved row denominator or fingerprint changed';
  END IF;
  SELECT encode(public.digest(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb)::text,'sha256'),'hex')
    INTO survivors_before FROM public.client_intel_mapping m WHERE NOT (m.id=ANY(candidate_ids));
  INSERT INTO capiro_incident_recovery.dedup_runs
    (run_id,tenant_id,approval_reference,expected_visible_rows,expected_candidate_ids,expected_candidate_fingerprint,visible_rows_after,deleted_rows)
    VALUES(p_run,p_tenant,p_approval_reference,p_expected_rows,p_expected_ids,p_expected_fingerprint,visible_rows-cardinality(candidate_ids),cardinality(candidate_ids));
  INSERT INTO capiro_incident_recovery.dedup_rows(run_id,tenant_id,row_id,keeper_id,original_row)
    SELECT p_run,p_tenant,id,keeper,original_row FROM (
      SELECT m.id,to_jsonb(m) AS original_row,
        first_value(m.id) OVER(PARTITION BY m.tenant_id,m.client_id,m.source,m.external_id ORDER BY m.id) AS keeper
      FROM public.client_intel_mapping m
    ) ranked WHERE id=ANY(candidate_ids);
  GET DIAGNOSTICS backed_up=ROW_COUNT;
  IF backed_up<>cardinality(candidate_ids) OR EXISTS(
    SELECT 1 FROM public.client_intel_mapping m
    WHERE m.id=ANY(candidate_ids) AND NOT EXISTS(
      SELECT 1 FROM capiro_incident_recovery.dedup_rows a
      WHERE a.run_id=p_run AND a.row_id=m.id AND a.tenant_id=m.tenant_id AND a.original_row=to_jsonb(m)
    )
  ) THEN RAISE EXCEPTION 'Backup verification failed'; END IF;
  DELETE FROM public.client_intel_mapping m
  USING capiro_incident_recovery.dedup_rows a
  WHERE a.run_id=p_run AND a.row_id=m.id AND a.tenant_id=m.tenant_id AND a.original_row=to_jsonb(m);
  GET DIAGNOSTICS actual_deleted=ROW_COUNT;
  IF actual_deleted<>cardinality(candidate_ids) THEN RAISE EXCEPTION 'Deleted count differs from approved candidates'; END IF;
  SELECT encode(public.digest(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb)::text,'sha256'),'hex')
    INTO survivors_after FROM public.client_intel_mapping m;
  IF survivors_before IS DISTINCT FROM survivors_after THEN RAISE EXCEPTION 'Survivor rows changed'; END IF;
  IF EXISTS(SELECT 1 FROM public.client_intel_mapping GROUP BY tenant_id,client_id,source,external_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Duplicates remain';
  END IF;
  RETURN actual_deleted;
END;
$repair$;
REVOKE ALL ON FUNCTION capiro_incident_recovery.deduplicate_mapping(uuid,uuid,text,bigint,uuid[],text) FROM PUBLIC, capiro_app, capiro_worker;
COMMIT;
