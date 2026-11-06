-- Explicit latest-observed contract, authorized separately from publisher-time v2.
-- Reuses existing immutable ledger and owner-reviewed qualification; no old rows are reclassified.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
DO $$ BEGIN
 IF current_user<>'capiro_master' THEN RAISE EXCEPTION 'DEFPROC_MIGRATION_OWNER_REQUIRED'; END IF;
 IF to_regprocedure('defproc_v2_private.active_populations(timestamp with time zone)') IS NULL
 OR to_regprocedure('public.defproc_money_flow_scope_v2(text[],text,text)') IS NULL
 THEN RAISE EXCEPTION 'DEFPROC_V2_REQUIRED'; END IF;
END $$;
ALTER TABLE public.defproc_producer_qualification_v2
 DROP CONSTRAINT defproc_producer_qualification_v2_contract_id_check,
 ADD CONSTRAINT defproc_producer_qualification_v2_contract_id_check
 CHECK(contract_id IN ('sam-contract-action/v2','sam-contract-action/observed-v1'));
CREATE FUNCTION defproc_v2_private.observed_payload_map(p jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE typ text; piid text; ag text; par text; pag text; mod text; trans text;
 signed text; amount numeric; action date; label text; aw text;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 typ:=defproc_v2_private.source_text(p#>'{coreData,awardOrIDVType,code}');
 IF upper(defproc_v2_private.source_text(p#>'{coreData,awardOrIDV}')) IS DISTINCT FROM 'AWARD'
  OR typ IS NULL OR typ NOT IN ('A','B','C','D') THEN RETURN NULL; END IF;
 IF p->'oldContractId' IS NOT NULL AND p->'oldContractId'<>'null'::jsonb AND p->'oldContractId'<>'[]'::jsonb THEN RETURN NULL; END IF;
 piid:=defproc_v2_private.component(p#>'{contractId,piid}'); ag:=defproc_v2_private.agency(p#>'{contractId,subtier,code}');
 par:=defproc_v2_private.component(p#>'{contractId,referencedIDVPiid}'); pag:=defproc_v2_private.agency(p#>'{contractId,referencedIDVSubtier,code}');
 IF piid IS NULL OR ag IS NULL THEN RETURN NULL; END IF;
 IF (typ IN ('A','C') OR coalesce(p#>'{contractId,referencedIDVPiid}','null'::jsonb)<>'null'::jsonb
  OR coalesce(p#>'{contractId,referencedIDVSubtier,code}','null'::jsonb)<>'null'::jsonb) AND (par IS NULL OR pag IS NULL) THEN RETURN NULL; END IF;
 mod:=defproc_v2_private.source_text(p#>'{contractId,modificationNumber}'); trans:=defproc_v2_private.source_text(p#>'{contractId,transactionNumber}');
 IF mod IS NULL OR trans IS NULL THEN RETURN NULL; END IF;
 amount:=defproc_v2_private.money(p#>'{awardDetails,dollars,actionObligation}');
 IF amount IS NULL THEN RETURN NULL; END IF;
 signed:=defproc_v2_private.source_text(p#>'{awardDetails,dates,dateSigned}'); action:=defproc_v2_private.day(signed);
 IF coalesce(p#>'{awardDetails,dates,dateSigned}','null'::jsonb)<>'null'::jsonb AND action IS NULL THEN RETURN NULL; END IF;
 -- Uninterpreted source label. Missing/null are allowed; never trim or assign a zone.
 IF coalesce(jsonb_typeof(p#>'{awardDetails,transactionData,lastModifiedDate}'),'null') NOT IN ('string','null') THEN RETURN NULL; END IF;
 label:=p#>>'{awardDetails,transactionData,lastModifiedDate}';
 IF length(label)>256 OR label ~ ('['||chr(1)||'-'||chr(31)||chr(127)||']') THEN RETURN NULL; END IF;
 aw:='CONT_AWD_'||piid||'_'||ag||'_'||coalesce(par,'-NONE-')||'_'||coalesce(pag,'-NONE-');
 RETURN jsonb_build_object('piid',piid,'agency',ag,'parentPiid',par,'parentAgency',pag,'awardUniqueId',aw,'awardIdentityKey',defproc_v2_private.award_key(aw),
 'modificationNumber',mod,'transactionNumber',trans,'actionDate',to_char(action,'YYYY-MM-DD'),
 'obligation',amount::numeric(20,2)::text,'sourceRevisionLabel',label,
 'sourceTransactionId','['||to_json('sam-contract-action/observed-v1'::text)::text||','||to_json(defproc_v2_private.award_key(aw))::text||','||to_json(mod)::text||','||to_json(trans)::text||']');
END $$;
CREATE FUNCTION defproc_v2_private.initial_observed_actions(known_at timestamptz,award_keys text[])
RETURNS TABLE(physical public.acquisition_award_transaction_revision,category text,award_unique_id text,transaction_number text,source_revision_label text)
LANGUAGE plpgsql STABLE SET search_path=pg_catalog AS $$
DECLARE x record; p jsonb; mapped jsonb; q public.defproc_producer_qualification_v2;
 member public.defproc_producer_qualification_member_v2; n bigint; candidate_key text; candidate_award text; prior public.acquisition_award_transaction_revision;
BEGIN
 IF defproc_v2_private.utc(known_at) IS NULL THEN RAISE EXCEPTION 'DEFPROC_V2_KNOWLEDGE_TIME'; END IF;
 FOR x IN
  WITH active AS MATERIALIZED (SELECT * FROM defproc_v2_private.active_populations(known_at))
  SELECT t AS r,h AS approval,m AS member FROM public.acquisition_award_transaction_revision t
  LEFT JOIN active h ON (h.contract_id,h.producer_commit::text,h.image_digest,h.run_id,h.target_id)=
   (t.raw_jsonb#>>'{acquisitionProvenance,contract}',t.raw_jsonb#>>'{acquisitionProvenance,producerCommit}',
    t.raw_jsonb#>>'{acquisitionProvenance,imageDigest}',t.raw_jsonb#>>'{acquisitionProvenance,runId}',t.raw_jsonb#>>'{acquisitionProvenance,targetId}')
  LEFT JOIN public.defproc_producer_qualification_member_v2 m ON
   (m.contract_id,m.producer_commit,m.image_digest,m.run_id,m.target_id,m.revision_id)=
   (h.contract_id,h.producer_commit,h.image_digest,h.run_id,h.target_id,t.id)
  WHERE t.recorded_at<=known_at AND t.award_identity_key=ANY(award_keys)
   AND t.raw_jsonb#>>'{acquisitionProvenance,contract}'='sam-contract-action/observed-v1'
 LOOP
  physical:=x.r; q:=x.approval; member:=x.member; category:='invalid_provenance';
  source_revision_label:=NULL; award_unique_id:=NULL; transaction_number:=NULL;
  p:=physical.raw_jsonb->'acquisitionProvenance';
  IF jsonb_typeof(physical.raw_jsonb) IS DISTINCT FROM 'object' OR jsonb_typeof(p) IS DISTINCT FROM 'object'
  THEN category:='legacy'; RETURN NEXT; CONTINUE; END IF;
  IF (p->>'contract'='sam-contract-action/observed-v1' AND p->>'producerCommit' ~ '^[a-f0-9]{40}$'
   AND p->>'imageDigest' ~ '^sha256:[a-f0-9]{64}$' AND p->>'runId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND p->>'targetId' ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND jsonb_typeof(physical.raw_jsonb->'sourcePayload')='object'
   AND jsonb_typeof(p->'contract')='string' AND jsonb_typeof(p->'producerCommit')='string'
   AND jsonb_typeof(p->'imageDigest')='string' AND jsonb_typeof(p->'runId')='string' AND jsonb_typeof(p->'targetId')='string') IS NOT TRUE
  THEN RETURN NEXT; CONTINUE; END IF;
  IF q.contract_id IS NULL OR member.revision_id IS NULL OR physical.recorded_at>q.completed_at
   OR member.source_payload_hash::text IS DISTINCT FROM p->>'sourcePayloadHash'
  THEN category:='unqualified_run'; RETURN NEXT; CONTINUE; END IF;
  IF member.reviewed_row IS DISTINCT FROM defproc_v2_private.row_object(physical) THEN RETURN NEXT; CONTINUE; END IF;
  mapped:=defproc_v2_private.observed_payload_map(physical.raw_jsonb->'sourcePayload');
  IF mapped IS NULL THEN RETURN NEXT; CONTINUE; END IF;
  -- Same full-ID candidates as the writer; knowledge cutoff prevents future catalog evidence.
  SELECT count(*),min(z.identity_key),min(z.award_unique_id) INTO n,candidate_key,candidate_award FROM (
   SELECT DISTINCT a.award_unique_id,r.identity_key FROM public.federal_award a
   JOIN public.acquisition_record_revision r ON r.source_record_id=a.award_unique_id
    AND r.source_system='usaspending' AND r.record_kind='award' AND r.recorded_at<=known_at
   WHERE a.piid=mapped->>'piid' AND defproc_v2_private.award_parts(a.award_unique_id)=
    ARRAY[mapped->>'piid',mapped->>'agency',mapped->>'parentPiid',mapped->>'parentAgency']
  ) z;
  IF n=0 THEN category:='no_award_match'; RETURN NEXT; CONTINUE; END IF;
  IF n<>1 THEN category:='multiple_award_matches'; RETURN NEXT; CONTINUE; END IF;
  IF candidate_key IS DISTINCT FROM defproc_v2_private.award_key(candidate_award) THEN RETURN NEXT; CONTINUE; END IF;
  mapped:=mapped||jsonb_build_object('awardUniqueId',candidate_award,'awardIdentityKey',candidate_key,'sourceTransactionId',
   '['||to_json('sam-contract-action/observed-v1'::text)::text||','||to_json(candidate_key)::text||','||to_json(mapped->>'modificationNumber')::text||','||to_json(mapped->>'transactionNumber')::text||']');
  IF NOT (candidate_key=ANY(q.award_identity_keys)) THEN category:='unqualified_run'; RETURN NEXT; CONTINUE; END IF;
  IF physical.source_system IS DISTINCT FROM 'sam_gov' OR physical.parent_award_identity_key IS NOT NULL
   OR physical.award_identity_key IS DISTINCT FROM candidate_key
   OR physical.source_transaction_id IS DISTINCT FROM mapped->>'sourceTransactionId'
   OR physical.transaction_identity_key IS DISTINCT FROM 'sam_gov|modification|'||defproc_v2_private.uri_component(physical.source_transaction_id)
   OR physical.piid IS DISTINCT FROM mapped->>'piid' OR physical.modification_number IS DISTINCT FROM mapped->>'modificationNumber'
   OR to_char(physical.action_date,'YYYY-MM-DD') IS DISTINCT FROM mapped->>'actionDate'
   OR physical.signed_obligation_delta IS DISTINCT FROM (mapped->>'obligation')::numeric
   OR physical.signed_outlay_delta IS NOT NULL OR p->>'awardUniqueId' IS DISTINCT FROM mapped->>'awardUniqueId'
   OR p->'sourceRevisionLabel' IS DISTINCT FROM mapped->'sourceRevisionLabel'
   OR p->>'revisionBasis' IS DISTINCT FROM 'latest_observed' OR p ? 'sourceRevisionOrder'
   OR physical.source_observed_at>known_at
   OR defproc_v2_private.utc(physical.source_observed_at) IS NULL
  THEN RETURN NEXT; CONTINUE; END IF;
  source_revision_label:=mapped->>'sourceRevisionLabel'; award_unique_id:=mapped->>'awardUniqueId'; transaction_number:=mapped->>'transactionNumber';
  IF physical.corrects_identity_key IS NOT NULL THEN category:='invalid_chain'; RETURN NEXT; CONTINUE; END IF;
  IF physical.supersedes_id IS NOT NULL THEN
   SELECT * INTO prior FROM public.acquisition_award_transaction_revision WHERE id=physical.supersedes_id;
   IF NOT FOUND OR prior.award_identity_key<>physical.award_identity_key OR prior.transaction_identity_key<>physical.transaction_identity_key
    OR prior.recorded_at>=physical.recorded_at THEN category:='invalid_chain'; RETURN NEXT; CONTINUE; END IF;
  END IF;
  category:='eligible';
  RETURN NEXT;
 END LOOP;
END $$;
CREATE FUNCTION defproc_v2_private.observed_classified(known_at timestamptz,award_keys text[])
RETURNS TABLE(physical public.acquisition_award_transaction_revision,category text,award_unique_id text,transaction_number text,source_revision_label text)
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
 WITH initial AS MATERIALIZED(SELECT * FROM defproc_v2_private.initial_observed_actions(known_at,award_keys)),
 clocks AS(SELECT (physical).transaction_identity_key k,max((physical).source_observed_at) latest
   FROM initial WHERE category='eligible' GROUP BY 1),
 heads AS(SELECT c.k,count(DISTINCT (i.physical).raw_jsonb->'sourcePayload') variants,
   (array_agg((i.physical).id ORDER BY (i.physical).recorded_at,(i.physical).id))[1] selected_id
   FROM initial i JOIN clocks c ON c.k=(i.physical).transaction_identity_key AND c.latest=(i.physical).source_observed_at
   WHERE i.category='eligible' GROUP BY c.k)
 SELECT i.physical,CASE WHEN i.category<>'eligible' THEN i.category
   WHEN h.variants<>1 THEN 'observation_fork' WHEN (i.physical).id=h.selected_id THEN 'selected'
   WHEN (i.physical).source_observed_at=c.latest THEN 'repeated_observation' ELSE 'prior_observation' END,
   i.award_unique_id,i.transaction_number,i.source_revision_label
 FROM initial i LEFT JOIN clocks c ON c.k=(i.physical).transaction_identity_key LEFT JOIN heads h ON h.k=c.k
$$;
CREATE FUNCTION public.defproc_observed_money_flow_v1(award_keys text[], known_at_text text DEFAULT NULL, include_details boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE snapshot_at timestamptz; result jsonb; groups_json jsonb; action_count bigint;
BEGIN
 IF include_details IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Explicit detail selection required'; END IF;
 IF award_keys IS NULL OR cardinality(award_keys) NOT BETWEEN 1 AND 25
 OR array_ndims(award_keys)<>1
 OR EXISTS(SELECT FROM unnest(award_keys) k WHERE k IS NULL OR length(k)>512 OR NOT defproc_v2_private.valid_award_key(k))
 OR (SELECT count(DISTINCT k) FROM unnest(award_keys) k)<>cardinality(award_keys)
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid finite canonical award scope'; END IF;
 snapshot_at:=CASE WHEN known_at_text IS NULL THEN statement_timestamp() ELSE defproc_v2_private.instant(known_at_text) END;
 IF snapshot_at IS NULL OR NOT isfinite(snapshot_at) OR snapshot_at>statement_timestamp()
 OR (known_at_text IS NOT NULL AND defproc_v2_private.utc(snapshot_at)<>known_at_text)
 THEN RAISE EXCEPTION USING ERRCODE='22023', MESSAGE='Invalid exact procurement clock'; END IF;

 WITH classified AS MATERIALIZED (
   SELECT * FROM defproc_v2_private.observed_classified(snapshot_at,award_keys)
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
    max((physical).source_observed_at) latest_source_observed_at,
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
    'latestSourceObservedAt',defproc_v2_private.utc(latest_source_observed_at),
    'latestRecordedAt',defproc_v2_private.utc(latest_recorded_at),'latestAttributeRecordedAt',defproc_v2_private.utc(latest_attribute_recorded_at)) AS entry,
    fiscal_year,awarding_agency,awarding_sub_tier,contractor_name,recipient_uei,attribute_state,vendor_key FROM grouped
 ), action_details AS (
   -- Project detail rows directly from attributed (already-joined selected rows with vendor attributes).
   -- transaction_identity_key: use the immutable stored value from physical, never fabricate.
   -- award_unique_id: use s.award_unique_id from classified top-level column (validated).
   -- obligation_usd: signed_obligation_delta::text (validated persisted money, never raw lexeme).
   -- sourcePayloadHash: correct path acquisitionProvenance.sourcePayloadHash.
   -- Org paths: official SAM coreData.federalOrganization.fundingInformation.fundingDepartment etc.
   -- submittingAgencyCode: contractId.subtier.code (piid-owning agency of the award itself).
   SELECT
    (s.physical).transaction_identity_key AS transaction_identity_key,
    (s.physical).award_identity_key AS award_identity_key,
    s.award_unique_id AS award_unique_id,
    (s.physical).id AS selected_revision_id,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'piid') AS piid,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'subtier'->'code') AS submitting_agency_code,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'referencedIDVPiid') AS parent_piid,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'referencedIDVSubtier'->'code') AS parent_agency_code,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'modificationNumber') AS modification_number,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'contractId'->'transactionNumber') AS transaction_number,
    defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'awardOrIDVType'->'code') AS award_type,
    CASE WHEN (s.physical).action_date IS NULL THEN NULL ELSE to_char((s.physical).action_date,'YYYY-MM-DD') END AS action_date,
    s.fiscal_year AS fiscal_year,
    (s.physical).signed_obligation_delta::text AS obligation_usd,
    NULL::text AS outlay_usd,
    s.source_revision_label AS source_revision_label,
    defproc_v2_private.utc((s.physical).source_observed_at) AS source_observed_at,
    defproc_v2_private.utc((s.physical).recorded_at) AS recorded_at,
    (s.physical).source_url AS source_url,
    (s.physical).raw_jsonb#>>'{acquisitionProvenance,sourcePayloadHash}' AS source_payload_hash,
    s.vendor_key AS vendor_key,
    s.contractor_name AS contractor_name,
    s.recipient_uei AS recipient_uei,
    CASE WHEN s.recipient_uei IS NOT NULL THEN 'source_uei' ELSE 'unresolved' END AS vendor_identity_state,
    s.attribute_state AS attribute_state,
    jsonb_build_object(
      'department',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingDepartment'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingDepartment'->'name')),
      'subtier',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingSubtier'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingSubtier'->'name')),
      'office',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingOffice'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'fundingInformation'->'fundingOffice'->'name'))
    ) AS funding_organization,
    jsonb_build_object(
      'department',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingDepartment'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingDepartment'->'name')),
      'subtier',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingSubtier'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingSubtier'->'name')),
      'office',jsonb_build_object(
        'code',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingOffice'->'code'),
        'name',defproc_v2_private.source_text((s.physical).raw_jsonb->'sourcePayload'->'coreData'->'federalOrganization'->'contractingInformation'->'contractingOffice'->'name'))
    ) AS contracting_organization
   FROM attributed s WHERE include_details
 )
 SELECT jsonb_build_object(
   'contract','defproc-observed-money-flow/v1','state',CASE WHEN t.actions=0 THEN 'unavailable' ELSE 'partial' END,
   'measure','latest_observed_actions','revisionBasis','latest_observed','currency','USD','knownAt',defproc_v2_private.utc(snapshot_at),'sourceThrough',NULL,
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
     jsonb_build_object('system','sam_gov','documentationUrl','https://open.gsa.gov/api/contract-awards/','semantics','latest-observed version per full action identity within reviewed bounded observations; publisher labels are uninterpreted; not complete history or verified publisher chronology; no reported action outlays'),
     jsonb_build_object('system','usaspending','documentationUrl','https://www.usaspending.gov/','semantics','latest known original-source award attributes; UEI is source-reported, not parent-company consolidation')),
   'actionDetails',coalesce((SELECT jsonb_agg(
     jsonb_build_object(
       'transactionIdentityKey',transaction_identity_key,
       'awardIdentityKey',award_identity_key,
       'awardUniqueId',award_unique_id,
       'selectedRevisionId',selected_revision_id::text,
       'piid',piid,
       'submittingAgencyCode',submitting_agency_code,
       'parentPiid',parent_piid,
       'parentAgencyCode',parent_agency_code,
       'modificationNumber',modification_number,
       'transactionNumber',transaction_number,
       'awardType',award_type,
       'actionDate',action_date,
       'fiscalYear',fiscal_year,
       'obligationUsd',obligation_usd,
       'outlayUsd',outlay_usd,
       'sourceRevisionLabel',source_revision_label,
       'sourceObservedAt',source_observed_at,
       'recordedAt',recorded_at,
       'sourceUrl',source_url,
       'sourcePayloadHash',source_payload_hash,
       'vendorKey',vendor_key,
       'contractorName',contractor_name,
       'recipientUei',recipient_uei,
       'vendorIdentityState',vendor_identity_state,
       'attributeState',attribute_state,
       'fundingOrganization',funding_organization,
       'contractingOrganization',contracting_organization
     ) ORDER BY transaction_identity_key COLLATE "C",selected_revision_id::text COLLATE "C"
   ) FROM action_details),'[]'::jsonb)
 ) INTO result FROM totals t;

 -- Hard cap: REFUSE entire result when action count exceeds 2500; LIMIT silently truncates, this does not.
 -- Use jsonb_typeof guard: jsonb_agg of empty set returns SQL NULL which jsonb_build_object stores as JSON null.
 action_count:=CASE WHEN jsonb_typeof(result->'actionDetails')='array' THEN jsonb_array_length(result->'actionDetails') ELSE 0 END;
 IF action_count > 2500 THEN RAISE EXCEPTION USING ERRCODE='54000', MESSAGE='Procurement actionDetails exceeds maximum row limit of 2500'; END IF;
 IF NOT include_details THEN result:=result-'actionDetails'; END IF;
 groups_json:=result->'groups';
 IF jsonb_array_length(groups_json)>500 OR jsonb_array_length(result->'provenance')>500 OR octet_length(result::text)>1048576
 THEN RAISE EXCEPTION USING ERRCODE='54000',MESSAGE='Finite procurement result limit exceeded'; END IF;
 RETURN result;
END $$;

-- No caller gains raw/private access. Only the closed finite projection is public to the app role.
DO $$ DECLARE f regprocedure; g record; BEGIN
 FOREACH f IN ARRAY ARRAY['defproc_v2_private.observed_payload_map(jsonb)'::regprocedure,
  'defproc_v2_private.initial_observed_actions(timestamp with time zone,text[])'::regprocedure,
  'defproc_v2_private.observed_classified(timestamp with time zone,text[])'::regprocedure,
  'public.defproc_observed_money_flow_v1(text[],text,boolean)'::regprocedure] LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  FOR g IN SELECT DISTINCT a.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.oid=f AND a.grantee<>0 AND a.grantee<>p.proowner
  LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',f,pg_get_userbyid(g.grantee)); END LOOP;
 END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.defproc_observed_money_flow_v1(text[],text,boolean) TO capiro_app;
COMMIT;
