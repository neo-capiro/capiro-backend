-- query_capiro_data / describe_capiro_data: publish federal awards on the public surface.
--
-- public.federal_award (USAspending prime contract awards, synchronized by
-- sync-federal-award / federal-award-mapping.ts) and public.federal_assistance_award
-- (USAspending assistance awards, sync-federal-assistance-awards.ts) are public
-- data with a recipient name on every row, but neither was a meri_public
-- relation, so questions such as "rank contract awards by company" had no
-- SQL path. This migration adds two views following the conventions of
-- 20281101010000_capiro_data_published_surface (owner role with definer
-- semantics, security_barrier, explicit SELECT grant to capiro_analytics_ro,
-- JSON metadata comments as 20281101180000 writes them). Additive: no existing
-- view, grant, policy, role or row changes. public.federal_award keeps its
-- direct analytics grant because query_global_data (global-dataset-registry.ts)
-- still reads it; public.federal_assistance_award never had one.
--
-- Column forms follow the writers: recipient_name is federal_award.contractor_name
-- (USAspending "Recipient Name", as published, so spellings vary; recipient_uei is
-- the stable company key), amount is USAspending "Award Amount" in USD,
-- pop_state is a two-letter postal code, congressional districts are text as
-- published ("02", "00", "90"). NAICS and PSC codes are not stored as columns
-- (they remain inside the raw payload) and are therefore not published.
DO $prerequisites$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_public_projection_owner') THEN
    RAISE EXCEPTION 'Expected the public projection owner role from 20281101010000_capiro_data_published_surface';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_public' AND c.relkind = 'v') <> 8 THEN
    RAISE EXCEPTION 'Expected the eight published public projection views';
  END IF;
  IF to_regclass('public.federal_award') IS NULL OR to_regclass('public.federal_assistance_award') IS NULL THEN
    RAISE EXCEPTION 'Expected public.federal_award and public.federal_assistance_award';
  END IF;
END
$prerequisites$;

GRANT SELECT ON TABLE public.federal_award, public.federal_assistance_award TO capiro_public_projection_owner;

SET ROLE capiro_public_projection_owner;

CREATE VIEW meri_public.federal_awards
WITH (security_barrier = true, security_invoker = false) AS
SELECT award_unique_id, piid, fain, contractor_name AS recipient_name, recipient_uei, awarding_agency, awarding_sub_tier, amount, description, pe_code, pe_code_source, pe_code_confidence, dod_acq_program_code, dod_acq_program_name, funding_tas_title, program_activity_name, funding_fy, pop_state, pop_congressional_district, recipient_state, recipient_congressional_district, action_date, awarded_at, base_award_signed_date, latest_action_date, pop_start_date, pop_end_date, source_last_modified_date, last_synced_at
FROM public.federal_award;

CREATE VIEW meri_public.federal_assistance_awards
WITH (security_barrier = true, security_invoker = false) AS
SELECT award_unique_id, fain, uri, award_type_code, award_type_label, recipient_name, recipient_uei, parent_recipient_name, parent_recipient_uei, assistance_listing_number, assistance_listing_title, funding_opportunity_number, awarding_agency, awarding_sub_tier, funding_agency, funding_sub_tier, total_obligated_amount, total_outlayed_amount, non_federal_funding_amount, description, start_date, end_date, last_modified_date, pop_state, pop_congressional_district, pop_city, recipient_state, recipient_congressional_district, recipient_city, subaward_count, last_synced_at
FROM public.federal_assistance_award;

COMMENT ON VIEW meri_public.federal_awards IS '{"description":"USAspending prime contract awards synchronized by Capiro, one row per award with the recipient (contractor) name on every row. Rank companies with SUM(amount) GROUP BY recipient_name (or recipient_uei for a stable company key).","grain":"One row per (award_unique_id), the USAspending generated unique award id.","primaryKey":["award_unique_id"],"relationships":[{"fields":["pe_code"],"referencedRelation":"program_elements","referencedFields":["pe_code"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the awards Capiro synchronized (defense-related windows and backfills); a missing award is absence within this ingestion, not in USAspending.","recipient_name is the name as published and spellings vary across awards; group by recipient_uei to count one company once, and keep parent and subsidiary names apart.","amount is the award amount as synchronized at the time of sync (USD), not a live or final obligation; outlays are not published here.","pe_code attribution is derived (pe_code_source, pe_code_confidence); it is not a USAspending fact.","NAICS and PSC codes are not published; use the canonical federal market readers for them."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.federal_awards.award_unique_id IS '{"description":"USAspending generated unique award id, e.g. CONT_AWD_FA860123C0001_9700_-NONE-_-NONE-; the key of this relation.","nullable":false}';
COMMENT ON COLUMN meri_public.federal_awards.piid IS '{"description":"Procurement Instrument Identifier (contract number) as published; null for the few assistance rows in this table."}';
COMMENT ON COLUMN meri_public.federal_awards.fain IS '{"description":"Federal Award Identification Number when the row is an assistance award; null for contracts."}';
COMMENT ON COLUMN meri_public.federal_awards.recipient_name IS '{"description":"Recipient (contractor) name as published by USAspending, e.g. LOCKHEED MARTIN CORPORATION; spellings vary, so group by recipient_uei to count a company once. Filter with ILIKE and a % pattern."}';
COMMENT ON COLUMN meri_public.federal_awards.recipient_uei IS '{"description":"Recipient Unique Entity Identifier (12 characters) when published; the stable company key across awards. Null when USAspending omitted it."}';
COMMENT ON COLUMN meri_public.federal_awards.awarding_agency IS '{"description":"Awarding agency name as published, e.g. Department of Defense."}';
COMMENT ON COLUMN meri_public.federal_awards.awarding_sub_tier IS '{"description":"Awarding sub-tier agency name as published, e.g. Department of the Air Force."}';
COMMENT ON COLUMN meri_public.federal_awards.amount IS '{"description":"USAspending Award Amount in US dollars (total obligation to date at synchronization); exact decimal string. Sum it to rank recipients.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_awards.description IS '{"description":"Award description text as published; filter with ILIKE."}';
COMMENT ON COLUMN meri_public.federal_awards.pe_code IS '{"description":"Program element the award was attributed to (program_elements.pe_code); derived, see pe_code_source and pe_code_confidence. Null when unattributed."}';
COMMENT ON COLUMN meri_public.federal_awards.pe_code_source IS '{"description":"How pe_code was derived: description_regex, dod_acquisition_program or uei_confirmed_r3_prime; null when pe_code is null."}';
COMMENT ON COLUMN meri_public.federal_awards.pe_code_confidence IS '{"description":"Confidence of the pe_code attribution from 0 to 1 (1 only when UEI-confirmed against a named prime); null when unattributed."}';
COMMENT ON COLUMN meri_public.federal_awards.dod_acq_program_code IS '{"description":"DoD Major Defense Acquisition Program code from the contract record, e.g. 198; 000 or NONE for non-program awards."}';
COMMENT ON COLUMN meri_public.federal_awards.dod_acq_program_name IS '{"description":"DoD Major Defense Acquisition Program name from the contract record, e.g. F-35."}';
COMMENT ON COLUMN meri_public.federal_awards.funding_tas_title IS '{"description":"Title of the dominant Treasury account that funded the award, e.g. RDT&E, Air Force; null when not enriched."}';
COMMENT ON COLUMN meri_public.federal_awards.program_activity_name IS '{"description":"Program activity of the dominant funding account, e.g. BASIC RESEARCH; null when not enriched."}';
COMMENT ON COLUMN meri_public.federal_awards.funding_fy IS '{"description":"Federal fiscal year of the dominant funding account row; null when not enriched."}';
COMMENT ON COLUMN meri_public.federal_awards.pop_state IS '{"description":"Primary place of performance state as a two-letter postal code, e.g. TX; null when USAspending omitted it."}';
COMMENT ON COLUMN meri_public.federal_awards.pop_congressional_district IS '{"description":"Primary place of performance congressional district as published text, e.g. 02; 00 for at-large, 90 or 98 when undetermined."}';
COMMENT ON COLUMN meri_public.federal_awards.recipient_state IS '{"description":"Recipient headquarters state as a two-letter postal code."}';
COMMENT ON COLUMN meri_public.federal_awards.recipient_congressional_district IS '{"description":"Recipient headquarters congressional district as published text, e.g. 02."}';
COMMENT ON COLUMN meri_public.federal_awards.action_date IS '{"description":"Date of the latest award action as synchronized (date, no time)."}';
COMMENT ON COLUMN meri_public.federal_awards.awarded_at IS '{"description":"Same action date carried as a UTC timestamp for older rows; prefer action_date."}';
COMMENT ON COLUMN meri_public.federal_awards.base_award_signed_date IS '{"description":"Base obligation (signing) date of the award (date)."}';
COMMENT ON COLUMN meri_public.federal_awards.latest_action_date IS '{"description":"Latest action date reported by USAspending (date)."}';
COMMENT ON COLUMN meri_public.federal_awards.pop_start_date IS '{"description":"Period of performance start date."}';
COMMENT ON COLUMN meri_public.federal_awards.pop_end_date IS '{"description":"Period of performance end date (current end, not potential end)."}';
COMMENT ON COLUMN meri_public.federal_awards.source_last_modified_date IS '{"description":"USAspending Last Modified Date of the award record (UTC); source-side change time."}';
COMMENT ON COLUMN meri_public.federal_awards.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON VIEW meri_public.federal_assistance_awards IS '{"description":"USAspending assistance awards (grants, cooperative agreements, direct payments and other assistance; award type codes 02-05) synchronized by Capiro, one row per award with the recipient name on every row. Rank recipients with SUM(total_obligated_amount) GROUP BY recipient_name or recipient_uei.","grain":"One row per (award_unique_id), the USAspending generated unique award id.","primaryKey":["award_unique_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the assistance awards Capiro synchronized (bounded windows); a missing award is absence within this ingestion, not in USAspending.","recipient_name is the name as published and spellings vary; group by recipient_uei to count one recipient once, and use parent_recipient_* for the parent organization.","Obligated, outlayed and non-federal amounts are separate quantities as synchronized; never sum them together.","This relation is distinct from federal_awards (contracts); do not UNION them without labelling the award kind."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.award_unique_id IS '{"description":"USAspending generated unique award id, e.g. ASST_NON_1234567_7022; the key of this relation.","nullable":false}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.fain IS '{"description":"Federal Award Identification Number as published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.uri IS '{"description":"USAspending URI identifier for aggregate assistance records; null for most grants."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.award_type_code IS '{"description":"USAspending assistance award type code.","enum":["02","03","04","05"]}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.award_type_label IS '{"description":"Assistance award type as published: Block Grant (02), Formula Grant (03), Project Grant (04) or Cooperative Agreement (05)."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.recipient_name IS '{"description":"Recipient name as published by USAspending, e.g. UNIVERSITY OF TEXAS AT AUSTIN; spellings vary, so group by recipient_uei to count a recipient once. Filter with ILIKE and a % pattern."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.recipient_uei IS '{"description":"Recipient Unique Entity Identifier (12 characters) when published; the stable recipient key. Null when USAspending omitted it."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.parent_recipient_name IS '{"description":"Parent organization name as published; null when the recipient has no parent record."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.parent_recipient_uei IS '{"description":"Parent organization Unique Entity Identifier when published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.assistance_listing_number IS '{"description":"Primary Assistance Listing (CFDA) number, e.g. 12.420; null when not published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.assistance_listing_title IS '{"description":"Primary Assistance Listing title, e.g. Military Medical Research and Development."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.funding_opportunity_number IS '{"description":"Grants.gov funding opportunity number the award answered, when published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.awarding_agency IS '{"description":"Awarding agency name as published, e.g. Department of Defense."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.awarding_sub_tier IS '{"description":"Awarding sub-tier agency name as published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.funding_agency IS '{"description":"Funding agency name as published (can differ from the awarding agency)."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.funding_sub_tier IS '{"description":"Funding sub-tier agency name as published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.total_obligated_amount IS '{"description":"Total obligated amount in US dollars as synchronized; exact decimal string. Sum it to rank recipients.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.total_outlayed_amount IS '{"description":"Total outlayed (paid) amount in US dollars as synchronized; a separate quantity from the obligation.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.non_federal_funding_amount IS '{"description":"Non-federal (matching) funding in US dollars as published; not federal money.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.description IS '{"description":"Award description text as published; filter with ILIKE."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.start_date IS '{"description":"Period of performance start date."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.end_date IS '{"description":"Period of performance current end date."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.last_modified_date IS '{"description":"USAspending Last Modified Date of the award record (UTC); source-side change time."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.pop_state IS '{"description":"Primary place of performance state as a two-letter postal code; null when USAspending omitted it."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.pop_congressional_district IS '{"description":"Primary place of performance congressional district as published text, e.g. 02; 00 for at-large, 90 or 98 when undetermined."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.pop_city IS '{"description":"Primary place of performance city as published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.recipient_state IS '{"description":"Recipient location state as a two-letter postal code."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.recipient_congressional_district IS '{"description":"Recipient location congressional district as published text."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.recipient_city IS '{"description":"Recipient location city as published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.subaward_count IS '{"description":"Number of subawards USAspending reports under this award; null when not published."}';
COMMENT ON COLUMN meri_public.federal_assistance_awards.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

RESET ROLE;

GRANT SELECT ON TABLE meri_public.federal_awards, meri_public.federal_assistance_awards TO capiro_analytics_ro;
