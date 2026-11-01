-- Source-only follow-up. Sole migration custodian executes after snapshot/qualification.
-- Reuses the admitted v2 classifiers; never changes historic views, rows or qualifications.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_user<>'capiro_master' THEN RAISE EXCEPTION 'DEFPROC_MIGRATION_OWNER_REQUIRED'; END IF;
 IF to_regprocedure('defproc_v2_private.classified(timestamp with time zone,text)') IS NULL
 OR to_regprocedure('defproc_v2_private.award_classified(timestamp with time zone)') IS NULL
 THEN RAISE EXCEPTION 'DEFPROC_V2_CLASSIFIERS_REQUIRED'; END IF;
END $$;

CREATE FUNCTION public.defproc_money_flow_scope_v2(award_keys text[], known_at_text text DEFAULT NULL, source_through text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot_at timestamptz; result jsonb; groups_json jsonb;
BEGIN
 IF award_keys IS NULL OR cardinality(award_keys) NOT BETWEEN 1 AND 25
 OR array_ndims(award_keys)<>1
 OR EXISTS(SELECT FROM unnest(award_keys) k WHERE k IS NULL OR length(k)>512 OR NOT defproc_v2_private.valid_award_key(k))
 OR (SELECT count(DISTINCT k) FROM unnest(award_keys) k)<>cardinality(award_keys)
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid finite canonical award scope'; END IF;
 snapshot_at:=CASE WHEN known_at_text IS NULL THEN statement_timestamp() ELSE defproc_v2_private.instant(known_at_text) END;
 IF snapshot_at IS NULL OR NOT isfinite(snapshot_at) OR snapshot_at>statement_timestamp()
 OR (known_at_text IS NOT NULL AND defproc_v2_private.utc(snapshot_at)<>known_at_text)
 OR (source_through IS NOT NULL AND (defproc_v2_private.instant(source_through) IS NULL
     OR defproc_v2_private.utc(defproc_v2_private.instant(source_through))<>source_through))
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid exact procurement clock'; END IF;

 WITH classified AS MATERIALIZED (
   SELECT * FROM defproc_v2_private.classified(snapshot_at,source_through)
   WHERE (physical).award_identity_key=ANY(award_keys)
 ), selected AS MATERIALIZED (SELECT * FROM classified WHERE category='selected'),
 catalog AS MATERIALIZED (
   SELECT * FROM defproc_v2_private.award_classified(snapshot_at) WHERE (physical).identity_key=ANY(award_keys)
 ), awards AS (
   SELECT (physical).identity_key award_key,
    defproc_v2_private.source_text((physical).raw_jsonb->'Awarding Agency') awarding_agency,
    defproc_v2_private.source_text((physical).raw_jsonb->'Awarding Sub Agency') awarding_sub_tier,
    defproc_v2_private.source_text((physical).raw_jsonb->'Recipient Name') contractor_name,
    CASE WHEN (physical).raw_jsonb->>'Recipient UEI' ~ '^[A-Z0-9]{12}$'
      AND jsonb_typeof((physical).raw_jsonb->'Recipient UEI')='string'
      THEN (physical).raw_jsonb->>'Recipient UEI' END recipient_uei,
    (physical).recorded_at attribute_recorded_at,(physical).id catalog_revision_id,(physical).source_url catalog_source_url
   FROM catalog WHERE category='selected'
 ), forks AS (SELECT DISTINCT (physical).identity_key award_key FROM catalog WHERE category='award_observation_fork'),
 attributed AS MATERIALIZED (
   SELECT s.*,w.awarding_agency,w.awarding_sub_tier,w.contractor_name,w.recipient_uei,w.attribute_recorded_at,
    CASE WHEN w.award_key IS NOT NULL THEN 'latest_known_catalog_observation'
     WHEN f.award_key IS NOT NULL THEN 'award_observation_fork' ELSE 'missing_catalog_attributes' END attribute_state,
    CASE WHEN w.recipient_uei IS NOT NULL THEN 'uei:'||w.recipient_uei ELSE 'award:'||(s.physical).award_identity_key END vendor_key,
    CASE WHEN (s.physical).action_date IS NULL THEN NULL ELSE extract(year FROM (s.physical).action_date)::integer
      +CASE WHEN extract(month FROM (s.physical).action_date)>=10 THEN 1 ELSE 0 END END fiscal_year
   FROM selected s LEFT JOIN awards w ON w.award_key=(s.physical).award_identity_key
   LEFT JOIN forks f ON f.award_key=(s.physical).award_identity_key
 ), grouped AS (
   SELECT fiscal_year,awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,attribute_state,vendor_key,
    count(*) actions,sum((physical).signed_obligation_delta) obligation_usd,sum((physical).signed_outlay_delta) outlay_usd,
    count((physical).signed_obligation_delta) obligation_known,count((physical).signed_outlay_delta) outlay_known,
    max(source_revision_order) latest_source_revision,max((physical).source_observed_at) latest_source_observed_at,
    max((physical).recorded_at) latest_recorded_at,max(attribute_recorded_at) latest_attribute_recorded_at
   FROM attributed GROUP BY 1,2,3,4,5,6,7
 ), provenance AS (
   SELECT (s.physical).award_identity_key award_key,(s.physical).source_url source_url,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,contract}' contract,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,producerCommit}' producer_commit,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,imageDigest}' image_digest,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,runId}' run_id,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,targetId}' target_id,
    w.catalog_revision_id,w.catalog_source_url,w.attribute_recorded_at,count(*) selected_actions
   FROM selected s LEFT JOIN awards w ON w.award_key=(s.physical).award_identity_key GROUP BY 1,2,3,4,5,6,7,8,9,10
 ), totals AS (
   SELECT count(*) actions,sum((physical).signed_obligation_delta) obligation_usd,sum((physical).signed_outlay_delta) outlay_usd,
    count((physical).signed_obligation_delta) obligation_known,count((physical).signed_outlay_delta) outlay_known FROM selected
 ), coverage AS (SELECT category,count(*) n FROM classified GROUP BY category),
 group_rows AS (
   SELECT jsonb_build_object('fiscalYear',fiscal_year,'awardingAgency',awarding_agency,'awardingSubTier',awarding_sub_tier,
    'contractorName',contractor_name,'recipientUei',recipient_uei,'vendorIdentityState',CASE WHEN recipient_uei IS NULL THEN 'unresolved' ELSE 'source_uei' END,
    'vendorKey',vendor_key,'attributeState',attribute_state,'actions',actions::text,'obligationUsd',obligation_usd::text,
    'outlayUsd',outlay_usd::text,'obligationKnown',obligation_known::text,'outlayKnown',outlay_known::text,
    'latestSourceRevision',latest_source_revision,'latestSourceObservedAt',defproc_v2_private.utc(latest_source_observed_at),
    'latestRecordedAt',defproc_v2_private.utc(latest_recorded_at),'latestAttributeRecordedAt',defproc_v2_private.utc(latest_attribute_recorded_at)) AS entry,
    fiscal_year,awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,attribute_state,vendor_key FROM grouped
 )
 SELECT jsonb_build_object(
   'contract','defproc-scoped-money-flow/v1','state',CASE WHEN t.actions=0 THEN 'unavailable' ELSE 'partial' END,
   'measure','qualified_observed_actions','currency','USD','knownAt',defproc_v2_private.utc(snapshot_at),'sourceThrough',source_through,
   'scope',jsonb_build_object('awardIdentityKeys',(SELECT jsonb_agg(k ORDER BY k COLLATE "C") FROM unnest(award_keys) k),'includesDescendants',false),
   'totals',CASE WHEN t.actions=0 THEN NULL ELSE jsonb_build_object('actions',t.actions::text,'obligationUsd',t.obligation_usd::text,
     'outlayUsd',t.outlay_usd::text,'obligationKnown',t.obligation_known::text,'outlayKnown',t.outlay_known::text) END,
   'coverage',coalesce((SELECT jsonb_object_agg(category,n::text) FROM coverage),'{}'::jsonb),
   'groups',coalesce((SELECT jsonb_agg(entry ORDER BY fiscal_year NULLS LAST,awarding_agency COLLATE "C" NULLS LAST,
      awarding_sub_tier COLLATE "C" NULLS LAST,vendor_key COLLATE "C",contractor_name COLLATE "C" NULLS LAST,
      recipient_uei COLLATE "C" NULLS LAST,attribute_state COLLATE "C") FROM group_rows),'[]'::jsonb),
   'provenance',coalesce((SELECT jsonb_agg(jsonb_build_object('awardIdentityKey',award_key,'contract',contract,'producerCommit',producer_commit,
     'imageDigest',image_digest,'runId',run_id,'targetId',target_id,'selectedActions',selected_actions::text,'sourceUrl',source_url,
     'catalogRevisionId',catalog_revision_id::text,'catalogSourceUrl',catalog_source_url,'attributeRecordedAt',defproc_v2_private.utc(attribute_recorded_at))
     ORDER BY award_key COLLATE "C",contract COLLATE "C",producer_commit COLLATE "C",image_digest COLLATE "C",run_id COLLATE "C",target_id COLLATE "C",source_url COLLATE "C" NULLS LAST) FROM provenance),'[]'::jsonb),
   'sources',jsonb_build_array(
     jsonb_build_object('system','sam_gov','documentationUrl','https://open.gsa.gov/api/contract-awards/','semantics','qualified observed signed action obligations; no reported action outlays'),
     jsonb_build_object('system','usaspending','documentationUrl','https://www.usaspending.gov/','semantics','latest known original-source award attributes; UEI is source-reported, not parent-company consolidation'))
 ) INTO result FROM totals t;
 groups_json:=result->'groups';
 IF jsonb_array_length(groups_json)>500 OR jsonb_array_length(result->'provenance')>500 OR octet_length(result::text)>1048576
 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Finite procurement result limit exceeded'; END IF;
 RETURN result;
END $$;

-- Only this closed safe projection becomes application-readable. Default grants are removed.
REVOKE ALL ON FUNCTION public.defproc_money_flow_scope_v2(text[],text,text) FROM PUBLIC;
DO $$ DECLARE grant_row record; BEGIN
 FOR grant_row IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='public.defproc_money_flow_scope_v2(text[],text,text)'::regprocedure AND a.grantee<>0 AND a.grantee<>p.proowner
 LOOP EXECUTE format('REVOKE ALL ON FUNCTION public.defproc_money_flow_scope_v2(text[],text,text) FROM %I',pg_get_userbyid(grant_row.grantee)); END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.defproc_money_flow_scope_v2(text[],text,text) TO capiro_app;
COMMIT;
