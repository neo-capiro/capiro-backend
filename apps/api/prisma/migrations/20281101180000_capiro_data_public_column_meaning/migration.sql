-- query_capiro_data / describe_capiro_data: column meaning for the public surface.
--
-- 20281101010000_capiro_data_published_surface published the eight meri_public
-- views with JSON view comments (grain, keys, relationships, limitations) but
-- most column comments only repeated the column name, so describe_capiro_data
-- told the model nothing about identifier formats, value vocabularies or units.
-- This migration replaces those column comments and extends the bills view
-- comment with the id format. Metadata only: no view, grant or role changes.
-- Forms are what the writers store, not what one might expect:
--   congress_member.party / state     scripts/sync-congress-members.ts stores the
--                                     Congress.gov member list verbatim: partyName
--                                     ("Democratic") and the full state name
--                                     ("Massachusetts"); name is "Last, First".
--   congress_bill.sponsor_* and       scripts/sync-congress.ts stores the bill
--   congress_bill_cosponsor.*         payloads verbatim: one-letter party ("D"),
--                                     two-letter state ("TX") and the display form
--                                     "Rep. Arrington, Jodey C. [R-TX-19]".
--   congress_bill.status              deriveBillStatus (@capiro/shared BillStatus)
--   congress_member.chamber           'house' | 'senate' (sync-congress-members.ts)
--   program_element.appropriation_type free text at the extraction contract
--                                     (defense-budget extraction-artifact-v1.ts);
--                                     the values seen are described, not enumerated.
-- Comments require the view owner. The private views keep their existing comments.
SET ROLE capiro_public_projection_owner;

COMMENT ON VIEW meri_public.congress_bills IS '{"description":"Canonical federal bills from Congress.gov (117th Congress onward as synchronized). id is <congress>-<bill_type>-<bill_number>, e.g. 119-hr-1234, and is the join key for subjects and cosponsors.","grain":"One row per (id).","primaryKey":["id"],"relationships":[{"fields":["sponsor_bioguide_id"],"referencedRelation":"congress_members","referencedFields":["bioguide_id"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Sponsor display name is not an identity key; member resolution can be absent.","sponsor_party and sponsor_state are one- and two-letter codes (D, TX) while congress_members.party and state are full names (Democratic, Texas): join members on bioguide_id, never on party or state text.","Bill text, actions, committees and votes are not in this relation: use the canonical bill readers for them."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.congress_bills.id IS '{"description":"Canonical bill id <congress>-<bill_type>-<bill_number>, e.g. 119-hr-1234; the key cosponsors and subjects reference as bill_id.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.congress IS '{"description":"Congress number, e.g. 119 for the 119th Congress (2025-2026).","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.bill_type IS '{"description":"Lowercase bill type code: hr and s are bills, hjres/sjres joint resolutions, hres/sres simple resolutions, hconres/sconres concurrent resolutions.","nullable":false,"enum":["hr","s","hjres","sjres","hres","sres","hconres","sconres"]}';
COMMENT ON COLUMN meri_public.congress_bills.bill_number IS '{"description":"Bill number within its type and Congress, stored as text (compare to a text parameter or cast to integer for numeric order).","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.title IS '{"description":"Official or display title as synchronized from Congress.gov; filter with ILIKE and a % pattern.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.policy_area IS '{"description":"Congress.gov single policy area term (one per bill), e.g. Health or Armed Forces and National Security; null when not assigned. Subjects are in congress_bill_subjects."}';
COMMENT ON COLUMN meri_public.congress_bills.status IS '{"description":"Derived legislative stage, lowercase; null when no stage could be derived. passed_chamber means passed its originating chamber only.","enum":["introduced","committee","reported","rule_pending","rule_failed","floor","passed_chamber","resolving","to_president","enacted","failed","vetoed"]}';
COMMENT ON COLUMN meri_public.congress_bills.status_at IS '{"description":"UTC time the stored stage was derived or last changed; not the date of the underlying action."}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_bioguide_id IS '{"description":"Bioguide id of the sponsor; join to congress_members.bioguide_id (soft: the member row can be absent). Null when Congress.gov did not resolve the sponsor."}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_name IS '{"description":"Sponsor display name in Congress.gov form, e.g. Rep. Arrington, Jodey C. [R-TX-19] or Sen. Risch, James E. [R-ID]; not an identity key. congress_members.full_name is the plain Last, First form instead."}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_state IS '{"description":"Two-letter postal code of the sponsor''s state or territory, e.g. TX. congress_members.state is the full name (Texas); compare the two only through bioguide_id."}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_party IS '{"description":"One-letter party code as published on the bill, e.g. D, R or I; null when unknown. congress_members.party is the party name (Democratic, Republican, Independent); map D to Democratic, R to Republican and I to Independent when comparing."}';
COMMENT ON COLUMN meri_public.congress_bills.introduced_date IS '{"description":"Calendar date the bill was introduced (date, no time); null when unknown. Use date_trunc or ranges on this column for per-month or per-year counts."}';
COMMENT ON COLUMN meri_public.congress_bills.latest_action_date IS '{"description":"Calendar date of the latest recorded action; null when none is stored."}';
COMMENT ON COLUMN meri_public.congress_bills.url IS '{"description":"Congress.gov URL of the bill; cite it as the public locator."}';
COMMENT ON COLUMN meri_public.congress_bills.update_date IS '{"description":"Congress.gov update timestamp of the bill record (UTC); source-side change time, not Capiro sync time."}';
COMMENT ON COLUMN meri_public.congress_bills.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON COLUMN meri_public.congress_bill_subjects.id IS '{"description":"Surrogate id of one subject assertion.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_subjects.bill_id IS '{"description":"Canonical bill id (congress_bills.id). The same bill can carry one subject several times: count DISTINCT bill_id.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_subjects.name IS '{"description":"Congress.gov legislative subject term, e.g. Armed Forces and National Security; exact text, so match with = or ILIKE.","nullable":false}';

COMMENT ON COLUMN meri_public.congress_bill_cosponsors.bill_id IS '{"description":"Canonical bill id (congress_bills.id).","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.bioguide_id IS '{"description":"Bioguide id of the cosponsor; join to congress_members.bioguide_id (soft). Use it, not full_name, to identify a member.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.full_name IS '{"description":"Cosponsor display name in Congress.gov form at sponsorship time, e.g. Sen. Risch, James E. [R-ID]; not unique. congress_members.full_name is the plain Last, First form instead.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.party IS '{"description":"One-letter party code at sponsorship time as published on the bill, e.g. D, R or I. congress_members.party is the party name (Democratic, Republican, Independent); map codes to names when comparing."}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.state IS '{"description":"Two-letter postal code of the cosponsor''s state or territory, e.g. ID. congress_members.state is the full name (Idaho)."}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.district IS '{"description":"House district number as published on the bill, e.g. 19; null when Congress.gov publishes none (senators)."}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.sponsorship_date IS '{"description":"Calendar date the cosponsorship was recorded."}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.is_original IS '{"description":"True when the member cosponsored at introduction (original cosponsor).","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.withdrawn_date IS '{"description":"Calendar date the cosponsorship was withdrawn; null means still active. Filter withdrawn_date IS NULL for active cosponsors."}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON COLUMN meri_public.congress_members.bioguide_id IS '{"description":"Bioguide id, the canonical member key (e.g. A000375); bills and cosponsors reference it.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.full_name IS '{"description":"Member name in the Congress.gov member-list form Last, First, e.g. Warren, Elizabeth; not unique, so never join or filter identity on it. Bill sponsor and cosponsor names use the Rep./Sen. display form instead.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.party IS '{"description":"Party name as published by the Congress.gov member list, e.g. Democratic, Republican or Independent; null when unknown. Bills and cosponsors carry one-letter codes (D, R, I) instead: WHERE party = ''D'' matches nothing here."}';
COMMENT ON COLUMN meri_public.congress_members.state IS '{"description":"Full state or territory name as published by the Congress.gov member list, e.g. Massachusetts; null when unknown. Bills and cosponsors carry two-letter postal codes (MA) instead."}';
COMMENT ON COLUMN meri_public.congress_members.district IS '{"description":"House district number as published by the member list; null when Congress.gov publishes none (senators, and at-large House seats such as Alaska in the current roster)."}';
COMMENT ON COLUMN meri_public.congress_members.chamber IS '{"description":"Chamber of the member''s latest stored term, lowercase.","nullable":false,"enum":["house","senate"]}';
COMMENT ON COLUMN meri_public.congress_members.is_current IS '{"description":"True when the member currently serves; false for former members still referenced by bills.","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.update_date IS '{"description":"Congress.gov update timestamp of the member record (UTC)."}';
COMMENT ON COLUMN meri_public.congress_members.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON COLUMN meri_public.program_elements.pe_code IS '{"description":"Program Element or procurement line code, e.g. 0604000X; the key the project and budget-position relations reference.","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.title IS '{"description":"Program element title as published in the budget justification books.","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.description IS '{"description":"Mission or program description text from the justification book; null when none was extracted."}';
COMMENT ON COLUMN meri_public.program_elements.service IS '{"description":"Owning service or agency display name (e.g. Army, Navy, Air Force, Space Force, DoD-wide); null when unknown."}';
COMMENT ON COLUMN meri_public.program_elements.service_code IS '{"description":"Short service code matching service (e.g. A, N, F, S, DW); null when unknown."}';
COMMENT ON COLUMN meri_public.program_elements.appropriation_type IS '{"description":"Appropriation family as extracted from the budget documents, free text; values seen: RDT&E (research, development, test and evaluation program elements), PROC (procurement lines), OM (operation and maintenance lines); null when unclassified."}';
COMMENT ON COLUMN meri_public.program_elements.budget_activity IS '{"description":"Budget activity code within the appropriation (e.g. 05 for System Development and Demonstration in RDT&E); null when unknown."}';
COMMENT ON COLUMN meri_public.program_elements.program_of_record IS '{"description":"Program of record name associated with the element; null when none is recorded."}';
COMMENT ON COLUMN meri_public.program_elements.source IS '{"description":"Ingestion source label of the row (which document family or directory produced it); not a URL.","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.first_seen_fy IS '{"description":"First federal fiscal year in which the element was observed in a budget source; null when unknown."}';
COMMENT ON COLUMN meri_public.program_elements.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON COLUMN meri_public.program_element_projects.id IS '{"description":"Surrogate id of the project row; the logical key is (pe_code, project_code).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.pe_code IS '{"description":"Parent program element code (program_elements.pe_code).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.project_code IS '{"description":"Project or sub-element code within the PE, e.g. 0001 or EW7; join project budget positions on both pe_code and project_code.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.title IS '{"description":"Project title from the justification book.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.mission IS '{"description":"Project mission narrative text; null when none was extracted."}';
COMMENT ON COLUMN meri_public.program_element_projects.fy IS '{"description":"Federal fiscal year of the justification book the project row was read from; null when unknown."}';
COMMENT ON COLUMN meri_public.program_element_projects.source IS '{"description":"Ingestion source label of the row; not a URL.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.source_url IS '{"description":"URL of the source document when known; cite it as the locator together with page_number."}';
COMMENT ON COLUMN meri_public.program_element_projects.page_number IS '{"description":"Page of the source document the row was read from; null when unknown."}';
COMMENT ON COLUMN meri_public.program_element_projects.source_document_id IS '{"description":"Capiro id of the stored source document; null when unknown. Use the canonical document readers to read it."}';
COMMENT ON COLUMN meri_public.program_element_projects.last_synced_at IS '{"description":"When Capiro last synchronized this row (UTC); the freshness field of this relation.","nullable":false}';

COMMENT ON COLUMN meri_public.program_element_budget_positions.id IS '{"description":"Surrogate id of the position row; the logical key is (pe_code, position_cycle, asserted_fy, value_kind).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.pe_code IS '{"description":"Program element code (program_elements.pe_code).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.position_cycle IS '{"description":"Budget book or stage that asserted this amount, e.g. pb_fy2026 for the FY2026 President''s Budget request. Filter one cycle before summing or comparing.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.asserted_fy IS '{"description":"Federal fiscal year FOR which this position asserts a value (a PB book asserts prior, current and outyears).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.source_url IS '{"description":"URL of the source document when known; cite it as the locator together with page_number."}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.page_number IS '{"description":"Page of the source document the amount was read from; null when unknown."}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.source_document_id IS '{"description":"Capiro id of the stored source document; null when unknown."}';

COMMENT ON COLUMN meri_public.program_element_project_budget_positions.id IS '{"description":"Surrogate id of the position row; the logical key is (pe_code, project_code, position_cycle, asserted_fy, value_kind).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.pe_code IS '{"description":"Program element code (program_elements.pe_code).","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.project_code IS '{"description":"Project code within the PE (program_element_projects.project_code); join on both pe_code and project_code.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.position_cycle IS '{"description":"Budget book or stage that asserted this amount, e.g. pb_fy2026 for the FY2026 President''s Budget request. Filter one cycle before summing or comparing.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.asserted_fy IS '{"description":"Federal fiscal year FOR which this position asserts a value.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.source_url IS '{"description":"URL of the source document when known; cite it as the locator together with page_number."}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.page_number IS '{"description":"Page of the source document the amount was read from; null when unknown."}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.source_document_id IS '{"description":"Capiro id of the stored source document; null when unknown."}';

RESET ROLE;
