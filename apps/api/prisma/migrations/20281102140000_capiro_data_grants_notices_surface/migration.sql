-- query_capiro_data / describe_capiro_data: publish federal grant opportunities
-- and SAM.gov contract opportunities on the public surface.
--
-- public.federal_grant (Grants.gov opportunities, written by the Tango funding
-- catalog, funding-catalog.mapper.ts grantFields) and public.sam_opportunity
-- (SAM.gov notices, funding-catalog.mapper.ts noticeFields) are public data the
-- semantic reads already cover by topic, but neither was a meri_public relation,
-- so counts, filters and trends over them ("how many open DoD grants close this
-- month", "Sources Sought notices by NAICS") had no SQL path. This migration adds
-- two views following 20281102100000_capiro_data_federal_awards_surface (owner
-- role with definer semantics, security_barrier, explicit SELECT grant to
-- capiro_analytics_ro, JSON metadata comments in the shape
-- sql-reader-connection.ts parses). Additive: no existing view, grant, policy,
-- role or row changes.
--
-- Only stable public identifiers are published: the Grants.gov opportunity id
-- (federal_grant.id, published as grants_gov_id) and the SAM.gov notice id. The
-- internal sam_opportunity.id uuid, raw payloads, embedding markers and the
-- notice point-of-contact name and email are not published. Three columns are
-- derived text, each from one stored column: eligibility and
-- assistance_listing_numbers join the stored arrays with '; ', and pop_state is
-- the place-of-performance state from place_of_performance_jsonb, which the
-- writers store either as a two-letter string or as {code, name}; any other
-- form is published as null.
DO $prerequisites$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_public_projection_owner') THEN
    RAISE EXCEPTION 'Expected the public projection owner role from 20281101010000_capiro_data_published_surface';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_public' AND c.relkind = 'v') <> 11 THEN
    RAISE EXCEPTION 'Expected the eleven published public projection views';
  END IF;
  IF to_regclass('public.federal_grant') IS NULL OR to_regclass('public.sam_opportunity') IS NULL THEN
    RAISE EXCEPTION 'Expected public.federal_grant and public.sam_opportunity';
  END IF;
END
$prerequisites$;

GRANT SELECT ON TABLE public.federal_grant, public.sam_opportunity TO capiro_public_projection_owner;

SET ROLE capiro_public_projection_owner;

CREATE VIEW meri_public.federal_grants
WITH (security_barrier = true, security_invoker = false) AS
SELECT id AS grants_gov_id, opportunity_number, title, agency, sub_agency, status, doc_type, category, funding_instrument, NULLIF(array_to_string(eligibility, '; '), '') AS eligibility, eligibility_text, NULLIF(array_to_string(cfda_numbers, '; '), '') AS assistance_listing_numbers, award_ceiling, award_floor, estimated_funding, expected_awards, cost_sharing, open_date, close_date, response_date_desc, description, url, last_updated_at, synced_at
FROM public.federal_grant;

CREATE VIEW meri_public.sam_opportunities
WITH (security_barrier = true, security_invoker = false) AS
SELECT notice_id, solicitation_number, title, notice_type, base_type, agency, sub_agency, office, set_aside, set_aside_code, naics_code, psc_code, CASE WHEN (CASE WHEN jsonb_typeof(place_of_performance_jsonb -> 'state') = 'object' THEN place_of_performance_jsonb -> 'state' ->> 'code' ELSE place_of_performance_jsonb ->> 'state' END) ~ '^[A-Za-z]{2}$' THEN upper(CASE WHEN jsonb_typeof(place_of_performance_jsonb -> 'state') = 'object' THEN place_of_performance_jsonb -> 'state' ->> 'code' ELSE place_of_performance_jsonb ->> 'state' END) END AS pop_state, posted_date, response_deadline, archive_date, active, description, source_url, last_synced_at
FROM public.sam_opportunity;

COMMENT ON VIEW meri_public.federal_grants IS '{"description":"Federal grant opportunities from Grants.gov as synchronized by Capiro, one row per opportunity: posted, forecasted, closed and archived. Open means status posted or forecasted and close_date null or today or later; a null close_date with an open status is still open (continuous or TBD deadlines, see response_date_desc).","grain":"One row per (grants_gov_id), the Grants.gov opportunity id.","primaryKey":["grants_gov_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the opportunities Capiro synchronized; a missing opportunity is absence within this ingestion, not on Grants.gov.","status can lag the source between synchronizations; combine it with close_date as described for open.","Award ceiling, floor and estimated funding are separate announced quantities in USD; never sum them together, and many rows leave them null.","category, funding_instrument, eligibility and eligibility_text come from detail enrichment and are null on most archived rows."],"freshnessField":"synced_at"}';
COMMENT ON COLUMN meri_public.federal_grants.grants_gov_id IS '{"description":"Grants.gov opportunity id (digits only, as text); the key of this relation and the id in the url.","nullable":false}';
COMMENT ON COLUMN meri_public.federal_grants.opportunity_number IS '{"description":"Funding opportunity number as published by the agency; not unique across revisions of a program."}';
COMMENT ON COLUMN meri_public.federal_grants.title IS '{"description":"Opportunity title as published; filter with ILIKE and a % pattern.","nullable":false}';
COMMENT ON COLUMN meri_public.federal_grants.agency IS '{"description":"Department name as published; spellings follow the source, so filter with ILIKE.","nullable":false}';
COMMENT ON COLUMN meri_public.federal_grants.sub_agency IS '{"description":"Agency beneath the department as published; null when not stated."}';
COMMENT ON COLUMN meri_public.federal_grants.status IS '{"description":"Grants.gov lifecycle status: posted (accepting applications), forecasted (announced, not yet posted), closed or archived. Open is status posted or forecasted with close_date null or not yet passed.","enum":["posted","forecasted","closed","archived"]}';
COMMENT ON COLUMN meri_public.federal_grants.doc_type IS '{"description":"Payload kind: synopsis (a posted opportunity) or forecast (dates are estimates).","enum":["synopsis","forecast"]}';
COMMENT ON COLUMN meri_public.federal_grants.category IS '{"description":"Funding category as published; values seen: Discretionary, Mandatory, Continuation, Earmark, Other; null when not enriched."}';
COMMENT ON COLUMN meri_public.federal_grants.funding_instrument IS '{"description":"Funding instrument types joined with \"; \", e.g. Grant; Cooperative Agreement; null when not enriched."}';
COMMENT ON COLUMN meri_public.federal_grants.eligibility IS '{"description":"Eligible applicant types joined with \"; \" as published, e.g. Small businesses; Private institutions of higher education; filter with ILIKE. Null when none were stated."}';
COMMENT ON COLUMN meri_public.federal_grants.eligibility_text IS '{"description":"Additional eligibility narrative as published; null when not stated."}';
COMMENT ON COLUMN meri_public.federal_grants.assistance_listing_numbers IS '{"description":"Assistance Listing (CFDA) numbers joined with \"; \", e.g. 12.420; 12.431; match one with ILIKE ''%12.420%''. Null when none were stated."}';
COMMENT ON COLUMN meri_public.federal_grants.award_ceiling IS '{"description":"Announced maximum award per recipient in US dollars; null when not stated.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_grants.award_floor IS '{"description":"Announced minimum award per recipient in US dollars; null or 0 when not stated.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_grants.estimated_funding IS '{"description":"Announced estimated total program funding in US dollars; a program total, not an award amount. Null when not stated.","unit":"USD"}';
COMMENT ON COLUMN meri_public.federal_grants.expected_awards IS '{"description":"Announced expected number of awards; null when not stated."}';
COMMENT ON COLUMN meri_public.federal_grants.cost_sharing IS '{"description":"True when the announcement requires cost sharing or matching; null when not stated."}';
COMMENT ON COLUMN meri_public.federal_grants.open_date IS '{"description":"Posted date, or for a forecast the estimated posting date."}';
COMMENT ON COLUMN meri_public.federal_grants.close_date IS '{"description":"Application close date, or for a forecast the estimated close date. May be null: a null close date on a posted or forecasted opportunity means a continuous or to-be-determined deadline (see response_date_desc), not that the opportunity closed."}';
COMMENT ON COLUMN meri_public.federal_grants.response_date_desc IS '{"description":"Publisher text explaining the close date when the date alone misleads, e.g. continuous, TBD or an explicit Eastern Time cutoff; null when not stated."}';
COMMENT ON COLUMN meri_public.federal_grants.description IS '{"description":"Opportunity synopsis text as published; filter with ILIKE."}';
COMMENT ON COLUMN meri_public.federal_grants.url IS '{"description":"Grants.gov opportunity page, https://www.grants.gov/search-results-detail/<grants_gov_id>; cite it."}';
COMMENT ON COLUMN meri_public.federal_grants.last_updated_at IS '{"description":"When the source last changed the opportunity (UTC); null when not reported."}';
COMMENT ON COLUMN meri_public.federal_grants.synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON VIEW meri_public.sam_opportunities IS '{"description":"SAM.gov contract opportunity notices as synchronized by Capiro, one row per notice: solicitations, presolicitations, sources sought, special and award notices. Open for responses means active and response_deadline null or not yet passed.","grain":"One row per (notice_id), the SAM.gov notice id.","primaryKey":["notice_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Only the notices Capiro synchronized; a missing notice is absence within this ingestion, not on SAM.gov.","active follows the archive date, which often trails the response deadline by weeks, so active alone admits notices whose response window has closed; also test response_deadline.","notice_type is the current type after amendments and is truncated to 32 characters; base_type is the original type. Award Notice rows announce awards, not open competitions.","pop_state is null when the notice did not state a two-letter place-of-performance state."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.sam_opportunities.notice_id IS '{"description":"SAM.gov notice id (32 lowercase hexadecimal characters, no dashes); the key of this relation and the id in source_url.","nullable":false}';
COMMENT ON COLUMN meri_public.sam_opportunities.solicitation_number IS '{"description":"Solicitation number as published; shared by every notice of one procurement (presolicitation, solicitation, amendments, award)."}';
COMMENT ON COLUMN meri_public.sam_opportunities.title IS '{"description":"Notice title as published; filter with ILIKE and a % pattern.","nullable":false}';
COMMENT ON COLUMN meri_public.sam_opportunities.notice_type IS '{"description":"Current SAM.gov notice type, truncated to 32 characters; values seen include Combined Synopsis/Solicitation, Solicitation, Award Notice, Sources Sought, Special Notice, Presolicitation (also spelled Pre solicitation) and Justification and Approval (J&A). Filter with ILIKE to catch both spellings.","nullable":false}';
COMMENT ON COLUMN meri_public.sam_opportunities.base_type IS '{"description":"The notice''s original SAM.gov type before amendments; a sources-sought notice later amended still has base_type Sources Sought. Null when not recorded."}';
COMMENT ON COLUMN meri_public.sam_opportunities.agency IS '{"description":"Department name as published; spellings follow the source, so filter with ILIKE."}';
COMMENT ON COLUMN meri_public.sam_opportunities.sub_agency IS '{"description":"Agency beneath the department as published; often null on DoD notices, which means not stated."}';
COMMENT ON COLUMN meri_public.sam_opportunities.office IS '{"description":"Contracting office name as published; filter with ILIKE."}';
COMMENT ON COLUMN meri_public.sam_opportunities.set_aside IS '{"description":"Set-aside description as published, e.g. Total Small Business Set-Aside (FAR 19.5); null means full and open competition or not stated."}';
COMMENT ON COLUMN meri_public.sam_opportunities.set_aside_code IS '{"description":"Set-aside code, e.g. SBA, SDVOSBC, 8AN, WOSB, HZC; null when no set-aside."}';
COMMENT ON COLUMN meri_public.sam_opportunities.naics_code IS '{"description":"NAICS code as text (normally six digits); compare as text or with LIKE ''5417%'' for an industry group."}';
COMMENT ON COLUMN meri_public.sam_opportunities.psc_code IS '{"description":"Product or Service Code as published (four characters); null when not stated."}';
COMMENT ON COLUMN meri_public.sam_opportunities.pop_state IS '{"description":"Place-of-performance state as an upper-case two-letter postal code, for example OH; null when the notice did not state one in that form."}';
COMMENT ON COLUMN meri_public.sam_opportunities.posted_date IS '{"description":"When the notice was posted (UTC)."}';
COMMENT ON COLUMN meri_public.sam_opportunities.response_deadline IS '{"description":"Response or offer due date and time (UTC); null when the notice states none, common for sources sought and award notices."}';
COMMENT ON COLUMN meri_public.sam_opportunities.archive_date IS '{"description":"When SAM.gov archives the notice (UTC); active turns false after it."}';
COMMENT ON COLUMN meri_public.sam_opportunities.active IS '{"description":"False once the archive date has passed. Not the response window: an active notice can be past its response_deadline.","nullable":false}';
COMMENT ON COLUMN meri_public.sam_opportunities.description IS '{"description":"Notice description text as published; filter with ILIKE."}';
COMMENT ON COLUMN meri_public.sam_opportunities.source_url IS '{"description":"SAM.gov notice page, https://sam.gov/opp/<notice_id>/view; cite it."}';
COMMENT ON COLUMN meri_public.sam_opportunities.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

RESET ROLE;

GRANT SELECT ON TABLE meri_public.federal_grants, meri_public.sam_opportunities TO capiro_analytics_ro;
