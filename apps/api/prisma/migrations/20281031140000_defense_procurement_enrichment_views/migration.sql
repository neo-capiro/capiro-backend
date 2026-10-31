-- Defense procurement enrichment schema, views and job grants.

-- The preview environment (app.capiro.ai -> capiro-preview-first-chat-core) reads
-- the new-stack database, which already carries the award ledger table, the SAM
-- catalog (federal_award, 170,039 rows) and the defense roles, but has no
-- enrichment table and none of the v_defproc_* views. The award ledger transfer
-- and the USAspending enrichment both need these objects to exist here, so they
-- ship as one forward migration in this repository's own lineage.

CREATE TABLE "defproc_award_enrichment_v1" (
    "piid" text NOT NULL,
    "award_key" text,
    "generated_award_id" text,
    "total_obligation" numeric,
    "total_outlay" numeric,
    "base_and_all_options" numeric,
    "base_exercised_options" numeric,
    "awarding_toptier" text,
    "awarding_subtier" text,
    "awarding_office" text,
    "funding_toptier" text,
    "funding_subtier" text,
    "funding_office" text,
    "recipient_name" text,
    "recipient_uei" text,
    "parent_award_piid" text,
    "date_signed" date,
    "period_start" date,
    "period_end" date,
    "source_url" text NOT NULL,
    "source_observed_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "defproc_award_enrichment_v1_pkey" PRIMARY KEY ("piid")
);

CREATE VIEW "v_defproc_award" AS
SELECT DISTINCT ON (piid) piid,
    awarding_agency,
    awarding_sub_tier,
    contractor_name,
    recipient_uei,
    funding_tas,
    program_activity_code,
    pe_code,
    pe_code_confidence,
    dod_acq_program_name,
    latest_action_date
   FROM federal_award
  WHERE piid IS NOT NULL
  ORDER BY piid, latest_action_date DESC NULLS LAST, action_date DESC NULLS LAST;

CREATE VIEW "v_defproc_family" AS
SELECT t.award_identity_key,
    min(t.piid) AS piid,
    max(a.awarding_agency) AS awarding_agency,
    max(a.awarding_sub_tier) AS awarding_sub_tier,
    max(a.contractor_name) AS contractor_name,
    max(a.recipient_uei) AS recipient_uei,
    count(*) AS actions,
    sum(t.signed_obligation_delta) AS obligation_usd,
    sum(t.signed_outlay_delta) AS outlay_usd,
    min(t.action_date) AS first_action,
    max(t.action_date) AS last_action
   FROM acquisition_award_transaction_revision t
     LEFT JOIN v_defproc_award a ON a.piid = t.piid
  GROUP BY t.award_identity_key;

CREATE VIEW "v_defproc_money_flow" AS
SELECT EXTRACT(year FROM t.action_date)::integer +
        CASE
            WHEN EXTRACT(month FROM t.action_date) >= 10::numeric THEN 1
            ELSE 0
        END AS fiscal_year,
    a.awarding_agency,
    a.awarding_sub_tier,
    a.contractor_name,
    a.recipient_uei,
    count(*) AS actions,
    sum(t.signed_obligation_delta) AS obligation_usd
   FROM acquisition_award_transaction_revision t
     JOIN v_defproc_award a ON a.piid = t.piid
  GROUP BY (EXTRACT(year FROM t.action_date)::integer +
        CASE
            WHEN EXTRACT(month FROM t.action_date) >= 10::numeric THEN 1
            ELSE 0
        END), a.awarding_agency, a.awarding_sub_tier, a.contractor_name, a.recipient_uei;

CREATE VIEW "v_defproc_reconcile" AS
SELECT ( SELECT sum(acquisition_award_transaction_revision.signed_obligation_delta) AS sum
           FROM acquisition_award_transaction_revision) AS ledger_total,
    ( SELECT sum(v_defproc_family.obligation_usd) AS sum
           FROM v_defproc_family) AS family_total,
    ( SELECT sum(v_defproc_money_flow.obligation_usd) AS sum
           FROM v_defproc_money_flow) AS flow_total,
    ( SELECT count(*) AS count
           FROM acquisition_award_transaction_revision) AS ledger_rows,
    ( SELECT sum(v_defproc_family.actions) AS sum
           FROM v_defproc_family) AS family_rows,
    ( SELECT EXTRACT(epoch FROM now())::bigint AS "extract") AS computed_at_epoch;

CREATE VIEW "v_defproc_sam_lookup" AS
SELECT uei,
    legal_name,
    dba,
    status
   FROM ( VALUES ('MF2LE5RK6L84'::text,'THE BOEING COMPANY'::text,''::text,'Active'::text), ('NJVNVWQJMPA4'::text,'THE BOEING COMPANY'::text,''::text,'Active'::text), ('WZWRLY4G3PL8'::text,'THE BOEING COMPANY'::text,''::text,'Active'::text), ('CWM4UN76ZQW8'::text,'LOCKHEED MARTIN CORPORATION'::text,''::text,'Active'::text), ('KDT2YLB34NT6'::text,'LOCKHEED MARTIN CORPORATION'::text,''::text,'Active'::text), ('NMHFLDYJJ4C5'::text,'LOCKHEED MARTIN CORPORATION'::text,''::text,'Active'::text), ('CCGBEVKUU2F3'::text,'RAYTHEON COMPANY'::text,''::text,'Active'::text), ('KLW3ZYL15493'::text,'RAYTHEON COMPANY'::text,''::text,'Active'::text), ('LCV2N9FVV739'::text,'NORTHROP GRUMMAN SYSTEMS CORPORATION'::text,''::text,'Active'::text), ('PK8PM2GNVMP8'::text,'NORTHROP GRUMMAN SYSTEMS CORPORATION'::text,''::text,'Active'::text), ('PQGNEEY9W5M3'::text,'NORTHROP GRUMMAN SYSTEMS CORPORATION'::text,''::text,'Active'::text), ('T9XKQSKMW4J1'::text,'NORTHROP GRUMMAN SYSTEMS CORPORATION'::text,'NORTHROP GRUMMAN IS'::text,'Active'::text), ('WTPJHYWAGGX7'::text,'NORTHROP GRUMMAN SYSTEMS CORPORATION'::text,'NORTHROP GRUMMAN SYSTEMS COR'::text,'Active'::text), ('TJ6PLVEXMA47'::text,'BAE SYSTEMS LAND & ARMAMENTS L.P.'::text,''::text,'Active'::text), ('X9S9DMKTAPY9'::text,''::text,''::text,'NOT_IN_SAM'::text), ('YNJNTZWVC3H6'::text,'BAE SYSTEMS LAND & ARMAMENTS L.P.'::text,''::text,'Active'::text), ('MAENKG4UJLK8'::text,'LOCKHEED MARTIN CORP'::text,''::text,'Active'::text), ('SJDEB3MKJEW5'::text,'LOCKHEED MARTIN CORP'::text,''::text,'Active'::text), ('CN7PNYLZLNV3'::text,'L3HARRIS TECHNOLOGIES, INC.'::text,''::text,'Active'::text), ('LB5KVANFKPY7'::text,'L3HARRIS TECHNOLOGIES, INC.'::text,'HARRIS CORP'::text,'Active'::text), ('PMH3MAVQGE44'::text,'L3HARRIS TECHNOLOGIES, INC.'::text,'L3HARRIS TECHNOLOGIES'::text,'Active'::text), ('TBM5NGMKWDN3'::text,'L3HARRIS TECHNOLOGIES, INC.'::text,'HARRIS CORP'::text,'Active'::text), ('J1T1FEN3PWX6'::text,'GENERAL ELECTRIC COMPANY'::text,''::text,'Active'::text), ('LGXXE8T6ECL8'::text,'GENERAL ELECTRIC COMPANY'::text,'COLIBRIUM ADDITIVE'::text,'Active'::text), ('JHY6AZA6H191'::text,'GENERAL DYNAMICS MISSION SYSTEMS, INC.'::text,''::text,'Active'::text), ('MWDRZJ2ZVPV7'::text,'GENERAL DYNAMICS MISSION SYSTEMS, INC.'::text,''::text,'Active'::text), ('J4Q3HP6NHK47'::text,'ROCKWELL COLLINS, INC.'::text,'COLLINS AEROSPACE GOVERNMENT'::text,'Active'::text), ('SWBKVD2EKUH7'::text,'ROCKWELL COLLINS, INC.'::text,'COLLINS AEROSPACE MILITARY A'::text,'Active'::text), ('FMXWYVVK3DL5'::text,'BAE SYSTEMS INFORMATION AND ELECTRONIC SYSTEMS INTEGRATION INC.'::text,'BAE SYSTEMS'::text,'Active'::text), ('FNZGNWHTXVL4'::text,'BAE SYSTEMS INFORMATION AND ELECTRONIC SYSTEMS INTEGRATION INC.'::text,''::text,'Active'::text), ('WMKXMDJFSXA7'::text,'BAE SYSTEMS INFORMATION AND ELECTRONIC SYSTEMS INTEGRATION INC.'::text,''::text,'Active'::text), ('HA3UFSU8FN75'::text,'L3 TECHNOLOGIES, INC.'::text,''::text,'Active'::text), ('LG6WVXVEEJN3'::text,'L3 TECHNOLOGIES, INC.'::text,'INSIGHT TECHNOLOGY'::text,'Active'::text)) t(uei, legal_name, dba, status);

CREATE VIEW "v_defproc_vendor_name_bridge" AS
SELECT upper(awardee_legal_business_name) AS name_key,
    count(DISTINCT awardee_uei) AS uei_count,
        CASE
            WHEN count(DISTINCT awardee_uei) = 1 THEN min(awardee_uei)
            ELSE NULL::text
        END AS sole_uei,
        CASE
            WHEN count(DISTINCT awardee_cage_code) = 1 THEN min(awardee_cage_code)
            ELSE NULL::text
        END AS sole_cage,
    count(*) AS source_rows
   FROM tango_dibbs_award
  WHERE awardee_legal_business_name IS NOT NULL AND awardee_uei IS NOT NULL
  GROUP BY (upper(awardee_legal_business_name));

CREATE VIEW "v_defproc_vendor_identity" AS
SELECT v.contractor_name,
    b.sole_uei AS resolved_uei,
    b.sole_cage AS resolved_cage,
        CASE
            WHEN b.name_key IS NULL THEN 'unresolved'::text
            WHEN b.uei_count = 1 THEN 'exact_name'::text
            ELSE 'ambiguous_name'::text
        END AS resolution_method,
    COALESCE(b.uei_count, 0::bigint) AS candidate_ueis,
    v.obligation_usd,
    v.actions
   FROM ( SELECT v_defproc_money_flow.contractor_name,
            sum(v_defproc_money_flow.obligation_usd) AS obligation_usd,
            sum(v_defproc_money_flow.actions) AS actions
           FROM v_defproc_money_flow
          WHERE v_defproc_money_flow.contractor_name IS NOT NULL
          GROUP BY v_defproc_money_flow.contractor_name) v
     LEFT JOIN v_defproc_vendor_name_bridge b ON b.name_key = upper(v.contractor_name);

CREATE VIEW "v_defproc_vendor_alias" AS
WITH normalized AS (
         SELECT v_defproc_vendor_identity.contractor_name,
            v_defproc_vendor_identity.resolved_uei,
            v_defproc_vendor_identity.resolved_cage,
            v_defproc_vendor_identity.resolution_method,
            v_defproc_vendor_identity.obligation_usd,
            v_defproc_vendor_identity.actions,
            TRIM(BOTH FROM regexp_replace(regexp_replace(regexp_replace(upper(v_defproc_vendor_identity.contractor_name), '[^A-Z0-9 ]'::text, ' '::text, 'g'::text), '\s+'::text, ' '::text, 'g'::text), '(( INCORPORATED| INC| CORPORATION| CORP| COMPANY| CO| LLC| LLP| LP| LTD| PLC))+$'::text, ''::text)) AS alias_key
           FROM v_defproc_vendor_identity
        )
 SELECT alias_key,
    count(*) AS name_variants,
    string_agg(contractor_name, ' | '::text ORDER BY contractor_name) AS names,
    count(DISTINCT resolved_uei) AS reported_ueis,
    min(resolved_uei) AS sole_uei,
    min(resolved_cage) AS sole_cage,
    sum(obligation_usd) AS obligation_usd,
    sum(actions) AS actions,
        CASE
            WHEN count(DISTINCT resolved_uei) = 1 THEN 'alias+uei'::text
            WHEN count(DISTINCT resolved_uei) > 1 THEN 'conflicting_uei'::text
            WHEN count(resolved_uei) = 0 THEN 'no_identifier'::text
            ELSE 'partial'::text
        END AS alias_status
   FROM normalized
  GROUP BY alias_key;

CREATE VIEW "v_defproc_vendor_alias_coverage" AS
SELECT alias_status,
    count(*) AS alias_groups,
    sum(name_variants) AS source_names,
    sum(actions) AS actions,
    sum(obligation_usd) AS obligation_usd,
    round(100::numeric * sum(obligation_usd) / sum(sum(obligation_usd)) OVER (), 2) AS pct_of_obligations
   FROM v_defproc_vendor_alias
  GROUP BY alias_status;

CREATE VIEW "v_defproc_vendor_candidates" AS
SELECT name_key,
    count(DISTINCT uei) AS candidate_ueis
   FROM ( SELECT DISTINCT upper(tango_dibbs_award.awardee_legal_business_name) AS name_key,
            tango_dibbs_award.awardee_uei AS uei
           FROM tango_dibbs_award
          WHERE tango_dibbs_award.awardee_uei IS NOT NULL AND tango_dibbs_award.awardee_legal_business_name IS NOT NULL) u
  GROUP BY name_key;

CREATE VIEW "v_defproc_vendor_identity_coverage" AS
SELECT resolution_method,
    count(*) AS vendors,
    sum(actions) AS actions,
    sum(obligation_usd) AS obligation_usd,
    round(100::numeric * sum(obligation_usd) / sum(sum(obligation_usd)) OVER (), 2) AS pct_of_obligations
   FROM v_defproc_vendor_identity
  GROUP BY resolution_method;

CREATE VIEW "v_defproc_vendor_sam_rollup" AS
SELECT u.name_key,
    count(*) FILTER (WHERE s.status = 'Active'::text) AS sam_registrations,
    count(DISTINCT s.legal_name) FILTER (WHERE s.status = 'Active'::text) AS sam_legal_names,
    min(s.legal_name) FILTER (WHERE s.status = 'Active'::text) AS resolved_legal_name,
    count(*) FILTER (WHERE s.status = 'NOT_IN_SAM'::text) AS unregistered_candidates
   FROM ( SELECT DISTINCT upper(tango_dibbs_award.awardee_legal_business_name) AS name_key,
            tango_dibbs_award.awardee_uei AS uei
           FROM tango_dibbs_award
          WHERE tango_dibbs_award.awardee_uei IS NOT NULL AND tango_dibbs_award.awardee_legal_business_name IS NOT NULL) u
     LEFT JOIN v_defproc_sam_lookup s ON s.uei = u.uei
  GROUP BY u.name_key;

CREATE VIEW "v_defproc_vendor_identity_v3" AS
SELECT v.contractor_name,
    v.obligation_usd,
    v.actions,
    COALESCE(c.candidate_ueis, 0::bigint) AS candidate_ueis,
    r.sam_legal_names,
    r.resolved_legal_name,
    COALESCE(r.sam_registrations, 0::bigint) AS sam_registrations,
    COALESCE(r.unregistered_candidates, 0::bigint) AS unregistered_candidates,
        CASE
            WHEN v.resolution_method = 'exact_name'::text THEN 'single_uei'::text
            WHEN COALESCE(c.candidate_ueis, 0::bigint) = 0 THEN 'no_identifier_held'::text
            WHEN r.sam_legal_names = 1 THEN 'sam_legal_entity'::text
            WHEN r.sam_legal_names > 1 THEN 'sam_conflict'::text
            WHEN COALESCE(r.sam_registrations, 0::bigint) = 0 THEN 'not_in_sam'::text
            ELSE 'unresolved'::text
        END AS resolution_method
   FROM v_defproc_vendor_identity v
     LEFT JOIN v_defproc_vendor_candidates c ON c.name_key = upper(v.contractor_name)
     LEFT JOIN v_defproc_vendor_sam_rollup r ON r.name_key = upper(v.contractor_name);

CREATE VIEW "v_defproc_vendor_identity_v3_coverage" AS
SELECT resolution_method,
    count(*) AS vendors,
    sum(actions) AS actions,
    sum(obligation_usd) AS obligation_usd,
    round(100::numeric * sum(obligation_usd) / sum(sum(obligation_usd)) OVER (), 2) AS pct_of_obligations
   FROM v_defproc_vendor_identity_v3
  GROUP BY resolution_method;

-- Read access for the serving role; read/write for the job role that runs the
-- enrichment verb. Conditional so migration history also applies where a role has
-- not been provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "defproc_award_enrichment_v1" TO "capiro_defense_job";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job_login') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE "defproc_award_enrichment_v1" TO "capiro_defense_job_login";
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
    GRANT SELECT ON TABLE "defproc_award_enrichment_v1" TO "capiro_defense_serve";
  END IF;
END
$$;

DO $$
DECLARE v text;
BEGIN
  FOREACH v IN ARRAY ARRAY['v_defproc_award','v_defproc_family','v_defproc_money_flow','v_defproc_reconcile','v_defproc_sam_lookup','v_defproc_vendor_name_bridge','v_defproc_vendor_identity','v_defproc_vendor_alias','v_defproc_vendor_alias_coverage','v_defproc_vendor_candidates','v_defproc_vendor_identity_coverage','v_defproc_vendor_sam_rollup','v_defproc_vendor_identity_v3','v_defproc_vendor_identity_v3_coverage'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job') THEN
      EXECUTE format('GRANT SELECT ON TABLE %I TO "capiro_defense_job"', v);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_job_login') THEN
      EXECUTE format('GRANT SELECT ON TABLE %I TO "capiro_defense_job_login"', v);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'capiro_defense_serve') THEN
      EXECUTE format('GRANT SELECT ON TABLE %I TO "capiro_defense_serve"', v);
    END IF;
  END LOOP;
END
$$;
