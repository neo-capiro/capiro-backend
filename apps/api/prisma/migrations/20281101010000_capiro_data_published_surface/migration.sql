-- Meri query_capiro_data: the database defines the published surface.
--
-- The authored-SQL compiler used to regenerate every statement over fixed
-- projections of raw public tables. It is replaced by a small statement gate
-- that passes the model's SELECT through verbatim, so the reader role, its
-- grants and search_path must be the only thing that decides which relations
-- and columns exist for it:
--
--   * meri_public holds the eight logical public projections as views owned by
--     a NOLOGIN owner role (definer semantics), exactly as meri_private holds
--     the client projections. capiro_analytics_ro reads the views and loses its
--     direct SELECT on the seven base tables that only fed those projections.
--     public.congress_bill keeps its grant because query_global_data (the
--     QuerySpec tool on the same role) still reads it.
--   * describe_capiro_data reads the surface from pg_catalog under the reader
--     role. The human-authored metadata that used to live in TypeScript
--     registries is stored on the views as JSON comments so there is one
--     registry: the database.
--       view comment:   {"description","grain","primaryKey","relationships",
--                        "limitations","freshnessField"}
--       column comment: {"description","nullable"?,"unit"?,"enum"?}
--
-- No existing policy, applied migration, data row or application role changes.
DO $prerequisites$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'capiro_analytics_ro' AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolbypassrls AND NOT r.rolcreaterole AND NOT r.rolcreatedb AND NOT r.rolreplication
  ) THEN
    RAISE EXCEPTION 'Expected the isolated public analytics reader role';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'meri_private' AND c.relkind = 'v') <> 15 THEN
    RAISE EXCEPTION 'Expected the fifteen private client projection views';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'capiro_public_projection_owner') THEN
    CREATE ROLE capiro_public_projection_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = 'capiro_public_projection_owner'
      AND (r.rolsuper OR r.rolinherit OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolcanlogin
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid))
  ) THEN
    RAISE EXCEPTION 'Public projection owner must be an ordinary isolated role';
  END IF;
END
$prerequisites$;

GRANT USAGE ON SCHEMA public TO capiro_public_projection_owner;
GRANT SELECT ON TABLE
  public.congress_bill,
  public.congress_bill_subject,
  public.congress_bill_cosponsor,
  public.congress_member,
  public.program_element,
  public.program_element_project,
  public.program_element_budget_position,
  public.program_element_project_budget_position
TO capiro_public_projection_owner;

CREATE SCHEMA meri_public AUTHORIZATION capiro_public_projection_owner;
REVOKE ALL ON SCHEMA meri_public FROM PUBLIC;

SET ROLE capiro_public_projection_owner;

CREATE VIEW meri_public.congress_bills
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, congress, bill_type, bill_number, title, policy_area, status, status_at, sponsor_bioguide_id, sponsor_name, sponsor_state, sponsor_party, introduced_date, latest_action_date, url, update_date, last_synced_at
FROM public.congress_bill;

CREATE VIEW meri_public.congress_bill_subjects
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, bill_id, name
FROM public.congress_bill_subject;

CREATE VIEW meri_public.congress_bill_cosponsors
WITH (security_barrier = true, security_invoker = false) AS
SELECT bill_id, bioguide_id, full_name, party, state, district, sponsorship_date, is_original, withdrawn_date, last_synced_at
FROM public.congress_bill_cosponsor;

CREATE VIEW meri_public.congress_members
WITH (security_barrier = true, security_invoker = false) AS
SELECT bioguide_id, full_name, party, state, district, chamber, is_current, update_date, last_synced_at
FROM public.congress_member;

CREATE VIEW meri_public.program_elements
WITH (security_barrier = true, security_invoker = false) AS
SELECT pe_code, title, description, service, service_code, appropriation_type, budget_activity, program_of_record, source, first_seen_fy, last_synced_at
FROM public.program_element
WHERE retired_at IS NULL;

CREATE VIEW meri_public.program_element_projects
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, pe_code, project_code, title, mission, fy, source, source_url, page_number, source_document_id, last_synced_at
FROM public.program_element_project;

CREATE VIEW meri_public.program_element_budget_positions
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, pe_code, position_cycle, asserted_fy, value_kind, amount, quantity, source_url, page_number, source_document_id, created_at
FROM public.program_element_budget_position;

CREATE VIEW meri_public.program_element_project_budget_positions
WITH (security_barrier = true, security_invoker = false) AS
SELECT id, pe_code, project_code, position_cycle, asserted_fy, value_kind, amount, quantity, source_url, page_number, source_document_id, created_at
FROM public.program_element_project_budget_position;

RESET ROLE;

REVOKE ALL ON ALL TABLES IN SCHEMA meri_public FROM PUBLIC;
GRANT USAGE ON SCHEMA meri_public TO capiro_analytics_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA meri_public TO capiro_analytics_ro;

-- The reader now reaches these only through meri_public. congress_bill stays
-- granted for query_global_data (global-dataset-registry.ts).
REVOKE SELECT ON TABLE
  public.congress_bill_subject,
  public.congress_bill_cosponsor,
  public.congress_member,
  public.program_element,
  public.program_element_project,
  public.program_element_budget_position,
  public.program_element_project_budget_position
FROM capiro_analytics_ro;

-- Published metadata. COMMENT requires the view owner.
SET ROLE capiro_public_projection_owner;
COMMENT ON VIEW meri_public.congress_bills IS '{"description":"Canonical federal bills; id includes Congress, bill type and number.","grain":"One row per (id).","primaryKey":["id"],"relationships":[{"fields":["sponsor_bioguide_id"],"referencedRelation":"congress_members","referencedFields":["bioguide_id"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Sponsor display name is not an identity key; member resolution can be absent."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.congress_bills.id IS '{"description":"id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.congress IS '{"description":"congress","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.bill_type IS '{"description":"bill_type","nullable":false,"enum":["hr","s","hjres","sjres","hres","sres","hconres","sconres"]}';
COMMENT ON COLUMN meri_public.congress_bills.bill_number IS '{"description":"bill_number","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.title IS '{"description":"title","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bills.policy_area IS '{"description":"policy_area"}';
COMMENT ON COLUMN meri_public.congress_bills.status IS '{"description":"status"}';
COMMENT ON COLUMN meri_public.congress_bills.status_at IS '{"description":"status_at"}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_bioguide_id IS '{"description":"sponsor_bioguide_id"}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_name IS '{"description":"sponsor_name"}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_state IS '{"description":"sponsor_state"}';
COMMENT ON COLUMN meri_public.congress_bills.sponsor_party IS '{"description":"sponsor_party"}';
COMMENT ON COLUMN meri_public.congress_bills.introduced_date IS '{"description":"introduced_date"}';
COMMENT ON COLUMN meri_public.congress_bills.latest_action_date IS '{"description":"latest_action_date"}';
COMMENT ON COLUMN meri_public.congress_bills.url IS '{"description":"url"}';
COMMENT ON COLUMN meri_public.congress_bills.update_date IS '{"description":"update_date"}';
COMMENT ON COLUMN meri_public.congress_bills.last_synced_at IS '{"description":"last_synced_at","nullable":false}';
COMMENT ON VIEW meri_public.congress_bill_subjects IS '{"description":"Named subject assertions associated with canonical bill IDs.","grain":"One row per (id).","primaryKey":["id"],"relationships":[{"fields":["bill_id"],"referencedRelation":"congress_bills","referencedFields":["id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","(bill_id, name) is not unique. Deduplicate bill IDs before counting bills."],"freshnessField":null}';
COMMENT ON COLUMN meri_public.congress_bill_subjects.id IS '{"description":"id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_subjects.bill_id IS '{"description":"bill_id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_subjects.name IS '{"description":"name","nullable":false}';
COMMENT ON VIEW meri_public.congress_bill_cosponsors IS '{"description":"Named cosponsors, including withdrawn sponsorships.","grain":"One row per (bill_id, bioguide_id).","primaryKey":["bill_id","bioguide_id"],"relationships":[{"fields":["bill_id"],"referencedRelation":"congress_bills","referencedFields":["id"],"cardinality":"many_to_one","integrity":"enforced"},{"fields":["bioguide_id"],"referencedRelation":"congress_members","referencedFields":["bioguide_id"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Use withdrawn_date IS NULL for active cosponsors. A missing member row does not remove the canonical cosponsor ID."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.bill_id IS '{"description":"bill_id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.bioguide_id IS '{"description":"bioguide_id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.full_name IS '{"description":"full_name","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.party IS '{"description":"party"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.state IS '{"description":"state"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.district IS '{"description":"district"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.sponsorship_date IS '{"description":"sponsorship_date"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.is_original IS '{"description":"is_original","nullable":false}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.withdrawn_date IS '{"description":"withdrawn_date"}';
COMMENT ON COLUMN meri_public.congress_bill_cosponsors.last_synced_at IS '{"description":"last_synced_at","nullable":false}';
COMMENT ON VIEW meri_public.congress_members IS '{"description":"Canonical Bioguide member roster.","grain":"One row per (bioguide_id).","primaryKey":["bioguide_id"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Current roster status does not establish historic membership. Names are not unique."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.congress_members.bioguide_id IS '{"description":"bioguide_id","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.full_name IS '{"description":"full_name","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.party IS '{"description":"party"}';
COMMENT ON COLUMN meri_public.congress_members.state IS '{"description":"state"}';
COMMENT ON COLUMN meri_public.congress_members.district IS '{"description":"district"}';
COMMENT ON COLUMN meri_public.congress_members.chamber IS '{"description":"chamber","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.is_current IS '{"description":"is_current","nullable":false}';
COMMENT ON COLUMN meri_public.congress_members.update_date IS '{"description":"update_date"}';
COMMENT ON COLUMN meri_public.congress_members.last_synced_at IS '{"description":"last_synced_at","nullable":false}';
COMMENT ON VIEW meri_public.program_elements IS '{"description":"Active public DoD program elements and procurement budget lines.","grain":"One row per (pe_code).","primaryKey":["pe_code"],"relationships":[],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Retired records are excluded. Appropriation type distinguishes RDT&E PEs from procurement lines."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.program_elements.pe_code IS '{"description":"pe_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.title IS '{"description":"title","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.description IS '{"description":"description"}';
COMMENT ON COLUMN meri_public.program_elements.service IS '{"description":"service"}';
COMMENT ON COLUMN meri_public.program_elements.service_code IS '{"description":"service_code"}';
COMMENT ON COLUMN meri_public.program_elements.appropriation_type IS '{"description":"appropriation_type"}';
COMMENT ON COLUMN meri_public.program_elements.budget_activity IS '{"description":"budget_activity"}';
COMMENT ON COLUMN meri_public.program_elements.program_of_record IS '{"description":"program_of_record"}';
COMMENT ON COLUMN meri_public.program_elements.source IS '{"description":"source","nullable":false}';
COMMENT ON COLUMN meri_public.program_elements.first_seen_fy IS '{"description":"first_seen_fy"}';
COMMENT ON COLUMN meri_public.program_elements.last_synced_at IS '{"description":"last_synced_at","nullable":false}';
COMMENT ON VIEW meri_public.program_element_projects IS '{"description":"Projects/sub-elements with mission narrative and nullable source locators.","grain":"One row per (pe_code, project_code).","primaryKey":["pe_code","project_code"],"relationships":[{"fields":["pe_code"],"referencedRelation":"program_elements","referencedFields":["pe_code"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Several projects can match one PE; deduplicate PE IDs before aggregating parent funding."],"freshnessField":"last_synced_at"}';
COMMENT ON COLUMN meri_public.program_element_projects.id IS '{"description":"id","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.pe_code IS '{"description":"pe_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.project_code IS '{"description":"project_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.title IS '{"description":"title","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.mission IS '{"description":"mission"}';
COMMENT ON COLUMN meri_public.program_element_projects.fy IS '{"description":"fy"}';
COMMENT ON COLUMN meri_public.program_element_projects.source IS '{"description":"source","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_projects.source_url IS '{"description":"source_url"}';
COMMENT ON COLUMN meri_public.program_element_projects.page_number IS '{"description":"page_number"}';
COMMENT ON COLUMN meri_public.program_element_projects.source_document_id IS '{"description":"source_document_id"}';
COMMENT ON COLUMN meri_public.program_element_projects.last_synced_at IS '{"description":"last_synced_at","nullable":false}';
COMMENT ON VIEW meri_public.program_element_budget_positions IS '{"description":"PE-level budget assertions, independent of project funding grain.","grain":"One row per (pe_code, position_cycle, asserted_fy, value_kind).","primaryKey":["pe_code","position_cycle","asserted_fy","value_kind"],"relationships":[{"fields":["pe_code"],"referencedRelation":"program_elements","referencedFields":["pe_code"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Position cycle identifies the asserting book/stage; asserted FY identifies the year funded. PB outyears are not that future year’s submitted request. Filter value_kind and cycle before summing. Use the PE timeline for consolidated/current/enacted funding.","Joining multiple projects can multiply parent amounts; SUM(DISTINCT amount) also loses equal-valued parents."],"freshnessField":null}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.id IS '{"description":"id","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.pe_code IS '{"description":"pe_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.position_cycle IS '{"description":"Budget book/stage that asserted this amount, e.g. pb_fy2026.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.asserted_fy IS '{"description":"Fiscal year FOR which this position asserts a value.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.value_kind IS '{"description":"total, quantity or (PE only) unit_cost; never combine different kinds.","nullable":false,"enum":["total","quantity","unit_cost"]}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.amount IS '{"description":"total: USD millions; quantity: units; unit_cost: USD millions per unit.","nullable":false,"unit":"value_kind dependent"}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.quantity IS '{"description":"Reported quantity when available.","unit":"units"}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.source_url IS '{"description":"source_url"}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.page_number IS '{"description":"page_number"}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.source_document_id IS '{"description":"source_document_id"}';
COMMENT ON COLUMN meri_public.program_element_budget_positions.created_at IS '{"description":"Stored row creation time, not source freshness.","nullable":false}';
COMMENT ON VIEW meri_public.program_element_project_budget_positions IS '{"description":"Project-level budget assertions; amount total is USD millions.","grain":"One row per (pe_code, project_code, position_cycle, asserted_fy, value_kind).","primaryKey":["pe_code","project_code","position_cycle","asserted_fy","value_kind"],"relationships":[{"fields":["pe_code"],"referencedRelation":"program_elements","referencedFields":["pe_code"],"cardinality":"many_to_one","integrity":"enforced"},{"fields":["pe_code","project_code"],"referencedRelation":"program_element_projects","referencedFields":["pe_code","project_code"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.","Position cycle identifies the asserting book/stage; asserted FY identifies the year funded. PB outyears are not that future year’s submitted request. Filter value_kind and cycle before summing. Use the PE timeline for consolidated/current/enacted funding.","Project value_kind supports total or quantity; project sums need not equal PE totals."],"freshnessField":null}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.id IS '{"description":"id","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.pe_code IS '{"description":"pe_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.project_code IS '{"description":"project_code","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.position_cycle IS '{"description":"Budget book/stage that asserted this amount, e.g. pb_fy2026.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.asserted_fy IS '{"description":"Fiscal year FOR which this position asserts a value.","nullable":false}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.value_kind IS '{"description":"total, quantity or (PE only) unit_cost; never combine different kinds.","nullable":false,"enum":["total","quantity"]}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.amount IS '{"description":"total: USD millions; quantity: units; unit_cost: USD millions per unit.","nullable":false,"unit":"value_kind dependent"}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.quantity IS '{"description":"Reported quantity when available.","unit":"units"}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.source_url IS '{"description":"source_url"}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.page_number IS '{"description":"page_number"}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.source_document_id IS '{"description":"source_document_id"}';
COMMENT ON COLUMN meri_public.program_element_project_budget_positions.created_at IS '{"description":"Stored row creation time, not source freshness.","nullable":false}';
RESET ROLE;

SET ROLE capiro_private_projection_owner;
COMMENT ON VIEW meri_private.client_objectives IS '{"description":"Current nondeleted standalone client objectives, including complete stored business fields and readiness. Independent of Strategy goals and advocacy history.","grain":"One current nondeleted standalone Objective per canonical id, within its client_id.","primaryKey":["client_id","id"],"relationships":[],"limitations":["Only currently authorized, nonarchived clients and nondeleted Objectives. General covers the current visible client roster; selected-client scope cannot broaden it.","No automatic-context three-item sample or hidden list cap. Explicit SQL filters/limits and output bounds still apply; returned rows do not establish source-universe completeness.","Create-request hashes, revision history and operational plans/ledgers are not exposed. Current Objective version and readiness do not authorize a write."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_objectives.id IS '{"description":"Canonical client Objective ID; never a Strategy goal or task ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.client_id IS '{"description":"Canonical client ID. Include it when joining activity to an Objective.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.request_id IS '{"description":"Original create-request correlation ID, not an approval, permission or current version.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.outcome IS '{"description":"Full stored desired outcome, including an empty draft value.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.government_problem IS '{"description":"Full stored government problem, including an empty draft value.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.ask_type IS '{"description":"funding, policy_authority, both, protect_funding or meri_propose; null when unselected.","enum":["funding","policy_authority","both","protect_funding","meri_propose"]}';
COMMENT ON COLUMN meri_private.client_objectives.minimum_win IS '{"description":"Full stored minimum win, including an empty draft value.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.limits IS '{"description":"Full stored limits; not a required readiness field.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.owner_user_id IS '{"description":"Attributed Objective owner; ownership does not narrow the read ACL."}';
COMMENT ON COLUMN meri_private.client_objectives.created_by_user_id IS '{"description":"Attributed creator, not an additional read ACL.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.status IS '{"description":"Stored draft, in_review or ready lifecycle state; independent of the computed readiness checklist.","nullable":false,"enum":["draft","in_review","ready"]}';
COMMENT ON COLUMN meri_private.client_objectives.version IS '{"description":"Current Objective optimistic-concurrency version, not a source-universe version.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.ready_at IS '{"description":"Stored ready transition time."}';
COMMENT ON COLUMN meri_private.client_objectives.review_requested_at IS '{"description":"Stored review-request transition time."}';
COMMENT ON COLUMN meri_private.client_objectives.created_at IS '{"description":"Stored Objective creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.updated_at IS '{"description":"Stored Objective modification time; not proof of source freshness.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_outcome IS '{"description":"Outcome has content after the canonical ECMAScript whitespace trim.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_government_problem IS '{"description":"Government problem has content after the canonical whitespace trim.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_ask_type IS '{"description":"Ask type is one of the five supported Objective ask types.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_minimum_win IS '{"description":"Minimum win has content after the canonical whitespace trim.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_completed_fields IS '{"description":"Number of true readiness checklist fields, from zero through four.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_required_fields IS '{"description":"Four, matching objectiveReadiness; limits and attribution are not required.","nullable":false}';
COMMENT ON COLUMN meri_private.client_objectives.readiness_is_ready IS '{"description":"All four checklist fields are complete. This does not change the stored lifecycle status.","nullable":false}';
COMMENT ON VIEW meri_private.client_activity IS '{"description":"Recorded client activity rows with complete stored business fields and validated Quick Log details. This is not the mixed Timeline union.","grain":"One stored client activity row per canonical id, within its client_id.","primaryKey":["id"],"relationships":[{"fields":["client_id","objective_id"],"referencedRelation":"client_objectives","referencedFields":["client_id","id"],"cardinality":"many_to_one","integrity":"soft"}],"limitations":["Stored client_activity rows only. No derived Timeline meetings, attachments, outreach drafts or mail threads, and no hidden first-500 Timeline union.","Malformed or legacy Quick Log metadata yields null detail fields as in projectActivityDetails; unrelated metadata is never exposed.","Objective linkage is historical and soft. Use a LEFT JOIN on both client_id and objective_id to retain unavailable references; never infer current status from a recorded version.","Underlying person/source IDs are references only. Their owners still enforce their own visibility. Query filters, row limits and byte truncation do not establish complete client history."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_activity.id IS '{"description":"Canonical recorded activity ID, not a derived Timeline synthetic ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.client_id IS '{"description":"Canonical client ID; use with objective_id for the Objective relationship.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.kind IS '{"description":"Stored activity kind, including note, request, decision and commitment.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.occurred_at IS '{"description":"Recorded occurrence time; may differ from insertion time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.title IS '{"description":"Full stored title, without an excerpt limit.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.body IS '{"description":"Full stored body; null and empty text remain distinct."}';
COMMENT ON COLUMN meri_private.client_activity.actor_user_id IS '{"description":"Attributed actor, not an additional read ACL."}';
COMMENT ON COLUMN meri_private.client_activity.person_id IS '{"description":"Stored person reference; not evidence of current Directory visibility."}';
COMMENT ON COLUMN meri_private.client_activity.source_type IS '{"description":"Stored underlying-record type; does not grant access to that record."}';
COMMENT ON COLUMN meri_private.client_activity.source_id IS '{"description":"Stored underlying-record identity; does not grant access to that record."}';
COMMENT ON COLUMN meri_private.client_activity.pinned IS '{"description":"Stored activity pin.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.due_at IS '{"description":"Stored due time."}';
COMMENT ON COLUMN meri_private.client_activity.settled_at IS '{"description":"Stored settlement time; null does not imply a due date."}';
COMMENT ON COLUMN meri_private.client_activity.created_by_user_id IS '{"description":"Attributed creator, not an additional read ACL."}';
COMMENT ON COLUMN meri_private.client_activity.created_at IS '{"description":"Stored row creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.updated_at IS '{"description":"Stored row modification observation; this is not a version or concurrency token.","nullable":false}';
COMMENT ON COLUMN meri_private.client_activity.origin IS '{"description":"Always recorded. Derived meeting, document, outreach and mail Timeline items are excluded.","nullable":false,"enum":["recorded"]}';
COMMENT ON COLUMN meri_private.client_activity.direction IS '{"description":"Validated Quick Log we_owe or they_owe, otherwise null.","enum":["we_owe","they_owe"]}';
COMMENT ON COLUMN meri_private.client_activity.counterparty IS '{"description":"Validated manually entered label, preserved verbatim; not a Directory identity."}';
COMMENT ON COLUMN meri_private.client_activity.objective_id IS '{"description":"Validated historical Objective reference; may be unavailable now."}';
COMMENT ON COLUMN meri_private.client_activity.objective_version IS '{"description":"Validated historical Objective version selected when the activity was recorded."}';
COMMENT ON COLUMN meri_private.client_activity.objective_revision_id IS '{"description":"Validated historical Objective revision ID; not a current revision or read authorization."}';
COMMENT ON COLUMN meri_private.client_activity.objective_availability IS '{"description":"current when the visible nondeleted same-client Objective has the recorded version; changed for a different version; unavailable when absent; null without a valid reference.","enum":["current","changed","unavailable"]}';
COMMENT ON VIEW meri_private.client_team_roster IS '{"description":"Complete saved account team: ranked owners merged once per user with explicit team memberships, as the account-team reader presents them.","grain":"One row per (client_id, user_id), even when an owner also has an explicit team membership.","primaryKey":["client_id","user_id"],"relationships":[],"limitations":["Only current authorized nonarchived clients are visible. Query limits do not establish tenant-wide completeness.","Owners retain the explicit membership role but have null membership_id and added_at, matching the account-team owner.","Inactive owner names remain in this roster. The separate ordered-owner projection redacts unavailable person fields.","Not a directory of all tenant users and not an access-grant list. No hidden first-page roster sample."],"freshnessField":null}';
COMMENT ON COLUMN meri_private.client_team_roster.client_id IS '{"description":"Canonical client ID; include it in roster/owner joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_team_roster.user_id IS '{"description":"Canonical assigned user ID. Assignment confers no client or wall access.","nullable":false}';
COMMENT ON COLUMN meri_private.client_team_roster.membership_id IS '{"description":"Explicit team membership row ID; null for every ranked owner."}';
COMMENT ON COLUMN meri_private.client_team_roster.email IS '{"description":"Current assigned user email, including historical inactive ranked owners.","nullable":false}';
COMMENT ON COLUMN meri_private.client_team_roster.first_name IS '{"description":"Current assigned user first name."}';
COMMENT ON COLUMN meri_private.client_team_roster.last_name IS '{"description":"Current assigned user last name."}';
COMMENT ON COLUMN meri_private.client_team_roster.role IS '{"description":"Full free-text explicit team role; null means no stated role, not a missing row."}';
COMMENT ON COLUMN meri_private.client_team_roster.is_primary_owner IS '{"description":"True only for rank 1; other ranked owners are false.","nullable":false}';
COMMENT ON COLUMN meri_private.client_team_roster.added_at IS '{"description":"Team membership creation time; null for ranked owners."}';
COMMENT ON COLUMN meri_private.client_team_roster.owner_rank IS '{"description":"Rank 1 through 4 for an owner; null for team-only members."}';
COMMENT ON COLUMN meri_private.client_team_roster.owner_available IS '{"description":"Active tenant membership for owners; null for team-only members."}';
COMMENT ON VIEW meri_private.client_account_owners IS '{"description":"Current ordered account assignments, preserving unavailable historical owners and the ordered-owner reader’s person redaction.","grain":"One row per (client_id, rank); each user has at most one rank for a client.","primaryKey":["client_id","rank"],"relationships":[{"fields":["client_id","user_id"],"referencedRelation":"client_team_roster","referencedFields":["client_id","user_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current authorized nonarchived clients are visible. Query limits do not establish tenant-wide completeness.","No assignments means zero rows. Unavailable historical assignments remain present with all person fields null.","The roster relationship is guaranteed by these paired projections, not a database foreign key to a view.","Ownership grants no client access. A query result is a read snapshot, not permission to replace assignments."],"freshnessField":null}';
COMMENT ON COLUMN meri_private.client_account_owners.client_id IS '{"description":"Canonical client ID; include it in owner/roster joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_account_owners.rank IS '{"description":"Canonical rank 1 through 4; not a score.","nullable":false}';
COMMENT ON COLUMN meri_private.client_account_owners.user_id IS '{"description":"Assigned user ID, retained when the historical owner becomes unavailable.","nullable":false}';
COMMENT ON COLUMN meri_private.client_account_owners.label IS '{"description":"Primary, Secondary, Tertiary or Quaternary for rank 1 through 4.","nullable":false,"enum":["Primary","Secondary","Tertiary","Quaternary"]}';
COMMENT ON COLUMN meri_private.client_account_owners.available IS '{"description":"True only when the assigned user is an active member and has an email.","nullable":false}';
COMMENT ON COLUMN meri_private.client_account_owners.person_id IS '{"description":"Assigned person ID only when available; otherwise null."}';
COMMENT ON COLUMN meri_private.client_account_owners.email IS '{"description":"Assigned person email only when available; otherwise null."}';
COMMENT ON COLUMN meri_private.client_account_owners.first_name IS '{"description":"Assigned person first name only when available; otherwise null."}';
COMMENT ON COLUMN meri_private.client_account_owners.last_name IS '{"description":"Assigned person last name only when available; otherwise null."}';
COMMENT ON COLUMN meri_private.client_account_owners.assignment_version IS '{"description":"Observed client account-owner version; not authorization or a current write precondition.","nullable":false}';
COMMENT ON VIEW meri_private.client_targets IS '{"description":"Full stored client target records and engagement priorities. Directory attributes are saved snapshots, not current representation or enrichment.","grain":"One saved target row per (client_id, id); (client_id, member_id) is also unique.","primaryKey":["client_id","id"],"relationships":[],"limitations":["Only current authorized nonarchived clients are visible. Query limits do not establish tenant-wide completeness.","No fresh staff classification or representedFacilities enrichment is performed. Stored values can be stale.","Missing fresh representation is not evidence that no facility is represented; use the canonical Targets reader for that question.","Manual and Meri-added saved rows are included. Recommendations not yet saved are not targets. No hidden list cap."],"freshnessField":null}';
COMMENT ON COLUMN meri_private.client_targets.id IS '{"description":"Canonical saved target row ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_targets.client_id IS '{"description":"Canonical client ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_targets.member_id IS '{"description":"Directory identifier; may be a congressional, staff or slash-containing state ID. Not a UUID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_targets.member_name IS '{"description":"Stored directory name snapshot."}';
COMMENT ON COLUMN meri_private.client_targets.source_directory IS '{"description":"Stored congress, state or staff directory discriminator.","nullable":false}';
COMMENT ON COLUMN meri_private.client_targets.party IS '{"description":"Stored party snapshot; nullable and not a controlled cross-directory enum."}';
COMMENT ON COLUMN meri_private.client_targets.state IS '{"description":"Stored state/district snapshot, possibly a named state district; not a two-letter state filter."}';
COMMENT ON COLUMN meri_private.client_targets.chamber IS '{"description":"Stored chamber snapshot."}';
COMMENT ON COLUMN meri_private.client_targets.committee IS '{"description":"Stored committee snapshot."}';
COMMENT ON COLUMN meri_private.client_targets.stored_staff_kind IS '{"description":"Saved staff classification only; may differ from the freshly resolved Targets UI."}';
COMMENT ON COLUMN meri_private.client_targets.tier IS '{"description":"Stored engagement priority, 1 highest through 3; null is untiered."}';
COMMENT ON COLUMN meri_private.client_targets.source IS '{"description":"Stored manual or meri attribution; not a claim of verified source evidence.","nullable":false}';
COMMENT ON COLUMN meri_private.client_targets.added_by_user_id IS '{"description":"Attributed creator, possibly null; no additional read ACL."}';
COMMENT ON COLUMN meri_private.client_targets.added_at IS '{"description":"When the target was saved, not directory freshness or a row version.","nullable":false}';
COMMENT ON VIEW meri_private.client_profiles IS '{"description":"Saved client business profile scalars from ClientsService.get, with full description and contact text.","grain":"One currently visible saved client per client_id.","primaryKey":["client_id"],"relationships":[],"limitations":["Current nonarchived clients and current wall grants only. SQL filters and row/byte limits do not establish complete client coverage.","Array fields are in client_profile_codes. Empty arrays remain empty; they are not negative eligibility evidence.","Arbitrary intakeData/profileNotes, full capabilities, facilities, submissions and advocacy remain at the existing full paged get_client_context reader. This is not its replacement.","Logo storage/signing and provider sync bookkeeping are not exposed. Saved identity references do not imply a fresh provider match."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_profiles.client_id IS '{"description":"Canonical client ID. Include it in child-record joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profiles.name IS '{"description":"Saved client name.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profiles.website IS '{"description":"Saved website; no fetch or verification."}';
COMMENT ON COLUMN meri_private.client_profiles.description IS '{"description":"Full saved description, not a summary."}';
COMMENT ON COLUMN meri_private.client_profiles.product_description IS '{"description":"Full saved product description."}';
COMMENT ON COLUMN meri_private.client_profiles.primary_contact_name IS '{"description":"Saved primary contact name."}';
COMMENT ON COLUMN meri_private.client_profiles.primary_contact_email IS '{"description":"Saved primary contact email; not an identity-directory lookup."}';
COMMENT ON COLUMN meri_private.client_profiles.primary_contact_phone IS '{"description":"Saved primary contact phone."}';
COMMENT ON COLUMN meri_private.client_profiles.status IS '{"description":"Stored client lifecycle status; archived clients are excluded.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profiles.sector_tag IS '{"description":"Stored sector tag."}';
COMMENT ON COLUMN meri_private.client_profiles.profile_type IS '{"description":"Stored profile type, including null."}';
COMMENT ON COLUMN meri_private.client_profiles.profile_status IS '{"description":"Stored profile status, separate from client lifecycle status.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profiles.uei IS '{"description":"Stored UEI identifier; leading characters are preserved."}';
COMMENT ON COLUMN meri_private.client_profiles.cage_code IS '{"description":"Stored CAGE identifier."}';
COMMENT ON COLUMN meri_private.client_profiles.canonical_entity_id IS '{"description":"Confirmed saved canonical entity reference; does not grant access to its directory record."}';
COMMENT ON COLUMN meri_private.client_profiles.created_by_user_id IS '{"description":"Saved creator UUID; not a joined user profile."}';
COMMENT ON COLUMN meri_private.client_profiles.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profiles.updated_at IS '{"description":"Record update time; not provider freshness.","nullable":false}';
COMMENT ON VIEW meri_private.client_profile_codes IS '{"description":"Typed saved client array entries, preserving their original order and duplicate entries.","grain":"One stored array element per client_id, family and one-based position.","primaryKey":["client_id","family","position"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Current nonarchived clients and current wall grants only. SQL filters and row/byte limits do not establish complete client coverage.","Empty arrays yield no child rows; join client_profiles to distinguish visible clients from missing entries. Empty applicant/certification arrays mean unknown, not ineligible.","Codes remain strings; LDA IDs are identifiers, not monetary values. This is saved association state, not current public filing coverage."],"freshnessField":null}';
COMMENT ON COLUMN meri_private.client_profile_codes.client_id IS '{"description":"Canonical client ID. Include it in child-record joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profile_codes.family IS '{"description":"One of submission_tracks, issue_codes, naics_codes, psc_codes, applicant_types, set_aside_certifications, lda_client_ids.","nullable":false,"enum":["submission_tracks","issue_codes","naics_codes","psc_codes","applicant_types","set_aside_certifications","lda_client_ids"]}';
COMMENT ON COLUMN meri_private.client_profile_codes.position IS '{"description":"One-based position within the stored array, transported as an exact integer string.","nullable":false}';
COMMENT ON COLUMN meri_private.client_profile_codes.value IS '{"description":"Exact saved code/label or decimal-text LDA identifier. No normalization, inference or provider lookup.","nullable":false}';
COMMENT ON VIEW meri_private.client_people IS '{"description":"Saved client people and recorded reporting hierarchy. Read-time title inference remains with ClientPeopleService.","grain":"One stored person per canonical id and client_id; duplicate email rows are not deduplicated.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"},{"fields":["client_id","reports_to_person_id"],"referencedRelation":"client_people","referencedFields":["client_id","id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Current nonarchived clients and current wall grants only. SQL filters and row/byte limits do not establish complete client coverage.","The canonical people reader overlays never-inferred auto_title rows. Use get_client_context people for that current presentation; stored_* fields deliberately do not claim inferred parity.","No organization-wide identity directory, inferred relationship graph, mail or meeting body access."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_people.client_id IS '{"description":"Canonical client ID. Include it in child-record joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.id IS '{"description":"Canonical saved ClientPerson ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.name IS '{"description":"Full saved name.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.title IS '{"description":"Full saved title."}';
COMMENT ON COLUMN meri_private.client_people.email IS '{"description":"Saved email."}';
COMMENT ON COLUMN meri_private.client_people.phone IS '{"description":"Saved phone."}';
COMMENT ON COLUMN meri_private.client_people.role IS '{"description":"Free-text saved relationship role."}';
COMMENT ON COLUMN meri_private.client_people.last_contact IS '{"description":"Saved last-contact time."}';
COMMENT ON COLUMN meri_private.client_people.notes IS '{"description":"Full saved notes, not an excerpt."}';
COMMENT ON COLUMN meri_private.client_people.stored_hierarchy_level IS '{"description":"Stored hierarchy level; null may mean unplaced or awaiting the existing read-time inference overlay."}';
COMMENT ON COLUMN meri_private.client_people.reports_to_person_id IS '{"description":"Saved manager ID within this client; null is no recorded manager."}';
COMMENT ON COLUMN meri_private.client_people.placement_source IS '{"description":"Stored auto_title/manual placement source.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.stored_placement_confidence IS '{"description":"Stored decimal confidence, preserved exactly; null for a manual placement. Not a current inference score."}';
COMMENT ON COLUMN meri_private.client_people.stored_review_required IS '{"description":"Saved review flag before any read-time title inference.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_people.updated_at IS '{"description":"Record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_contacts IS '{"description":"Saved EngagementContact business fields for currently visible client associations.","grain":"One saved EngagementContact per id associated with a visible client.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Current nonarchived clients and current wall grants only. SQL filters and row/byte limits do not establish complete client coverage.","Null-client contacts are excluded from this client projection. Raw metadata, inferred associations and directory records stay with their existing owners.","No deduplication by display name or email across the two distinct people/contact owners."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_contacts.client_id IS '{"description":"Canonical client ID. Include it in child-record joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_contacts.id IS '{"description":"Canonical EngagementContact ID; distinct from ClientPerson IDs.","nullable":false}';
COMMENT ON COLUMN meri_private.client_contacts.full_name IS '{"description":"Saved full name."}';
COMMENT ON COLUMN meri_private.client_contacts.email IS '{"description":"Saved contact email."}';
COMMENT ON COLUMN meri_private.client_contacts.phone IS '{"description":"Saved phone."}';
COMMENT ON COLUMN meri_private.client_contacts.organization IS '{"description":"Saved organization."}';
COMMENT ON COLUMN meri_private.client_contacts.title IS '{"description":"Saved title."}';
COMMENT ON COLUMN meri_private.client_contacts.source IS '{"description":"Saved contact origin.","nullable":false}';
COMMENT ON COLUMN meri_private.client_contacts.directory_entry_id IS '{"description":"Saved external directory identifier; not a UUID or a grant."}';
COMMENT ON COLUMN meri_private.client_contacts.acquisition_personnel_id IS '{"description":"Saved acquisition-personnel reference only."}';
COMMENT ON COLUMN meri_private.client_contacts.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_contacts.updated_at IS '{"description":"Record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_engagement_tasks IS '{"description":"Saved client-associated EngagementTask business fields under the current exact task reader client/wall scope.","grain":"One saved client-associated EngagementTask per id and client_id.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.","Selected client is fixed by current Core authority. General queries may cover all currently visible clients; use owner_user_id for assigned-to-me filtering, matching the current reader optional assignment filter.","Null-client General tasks and research_portfolio_action tasks are excluded. Q06 PlannerTask is a separate owner and is never included.","Meeting/contact/mail/source linkage IDs and their bodies are omitted; use the exact task reader for its separately checked links and source-change receipt. Saved descriptions are returned as saved."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.client_id IS '{"description":"Canonical current visible client ID; include it in joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.id IS '{"description":"Canonical EngagementTask ID; never a PlannerTask ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.title IS '{"description":"Full saved title.","nullable":false}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.description IS '{"description":"Full saved task body."}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.owner_user_id IS '{"description":"Saved assignee UUID; null means unassigned."}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.due_date IS '{"description":"Saved due date; null is no deadline."}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.status IS '{"description":"Saved todo/in_progress/blocked/done/canceled status; no open-only default.","nullable":false}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.source_type IS '{"description":"Saved origin kind; Research Portfolio source rows are excluded."}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.created_by_user_id IS '{"description":"Saved creator UUID."}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_engagement_tasks.updated_at IS '{"description":"Record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_action_items IS '{"description":"Saved ActionRecommendation business scalars; evidence remains at the exact action-item reader.","grain":"One saved ActionRecommendation per id and client_id.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.","Target audience, confidence bands and evidence JSON are not exposed as raw JSON. query_action_items supplies complete typed fields and revalidates current nonsuperseded source documents.","These saved assertions are not fresh source evidence or an execution approval. No source document or artifact access is inferred from program/delta references."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_action_items.client_id IS '{"description":"Canonical current visible client ID; include it in joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.id IS '{"description":"Canonical saved ActionRecommendation ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.district_key IS '{"description":"Saved district key."}';
COMMENT ON COLUMN meri_private.client_action_items.pe_code IS '{"description":"Saved program-element code."}';
COMMENT ON COLUMN meri_private.client_action_items.program_id IS '{"description":"Saved program reference, not a source grant."}';
COMMENT ON COLUMN meri_private.client_action_items.delta_id IS '{"description":"Saved change reference, not current evidence."}';
COMMENT ON COLUMN meri_private.client_action_items.action_type IS '{"description":"Saved action type.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.issue_title IS '{"description":"Full saved issue title.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.what_changed IS '{"description":"Full saved change account.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.why_it_matters IS '{"description":"Full saved rationale.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.recommended_action IS '{"description":"Full saved recommended action.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.suggested_artifact_type IS '{"description":"Saved suggested artifact type."}';
COMMENT ON COLUMN meri_private.client_action_items.deadline IS '{"description":"Saved deadline; null is unknown."}';
COMMENT ON COLUMN meri_private.client_action_items.deadline_source IS '{"description":"Saved deadline origin."}';
COMMENT ON COLUMN meri_private.client_action_items.owner_user_id IS '{"description":"Saved assignee UUID."}';
COMMENT ON COLUMN meri_private.client_action_items.priority IS '{"description":"Stored integer priority, transported exactly.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.uncertainty IS '{"description":"Full saved uncertainty statement."}';
COMMENT ON COLUMN meri_private.client_action_items.status IS '{"description":"Saved workflow status.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.dismissal_reason IS '{"description":"Full saved dismissal reason."}';
COMMENT ON COLUMN meri_private.client_action_items.outcome IS '{"description":"Full saved outcome."}';
COMMENT ON COLUMN meri_private.client_action_items.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_action_items.updated_at IS '{"description":"Record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_tracked_bills IS '{"description":"Saved manually tracked bill records owned by IntelligenceManualBillTracking, without public bill hydration.","grain":"One saved client/bill tracking record per id; source uniqueness is client_id plus bill_id.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.","No public bill text/status join or cross-database bridge. Use the canonical public bill reader for current public evidence.","last_seen_* alert reconciliation state is not exposed or presented as source freshness."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_tracked_bills.client_id IS '{"description":"Canonical current visible client ID; include it in joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_tracked_bills.id IS '{"description":"Canonical saved TrackedBill row ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_tracked_bills.bill_id IS '{"description":"Canonical public bill text ID such as 119-hr-1234; not a UUID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_tracked_bills.note IS '{"description":"Full saved tracking note."}';
COMMENT ON COLUMN meri_private.client_tracked_bills.source IS '{"description":"Saved tracking origin, including null for legacy rows."}';
COMMENT ON COLUMN meri_private.client_tracked_bills.created_by IS '{"description":"Saved Clerk creator identifier; never an application user UUID."}';
COMMENT ON COLUMN meri_private.client_tracked_bills.created_at IS '{"description":"Tracking record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_tracked_bills.updated_at IS '{"description":"Tracking record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_outreach_campaigns IS '{"description":"Saved EngagementCampaign scalar records, matching listCampaigns/getCampaign client visibility, with full saved body.","grain":"One client-associated saved EngagementCampaign per id and client_id.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.","Null-client campaigns are excluded. Raw sourceContext/metadata, generated artifacts, send intents and provider receipts remain with their owners.","Classic OutreachRecord is a different creator-only owner with linked meeting/prep/debrief and source-grant checks; it is not included here. This relation never supplies send authority."],"freshnessField":"updated_at"}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.client_id IS '{"description":"Canonical current visible client ID; include it in joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.id IS '{"description":"Canonical EngagementCampaign ID; not an OutreachRecord ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.created_by_user_id IS '{"description":"Saved campaign creator UUID. The existing campaign read policy is tenant/client-wall scoped, not creator-only.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.name IS '{"description":"Full saved campaign name.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.type IS '{"description":"Saved campaign type.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.status IS '{"description":"Saved campaign status; not a current provider receipt.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.subject IS '{"description":"Full saved subject."}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.body IS '{"description":"Full saved campaign body, not a 2000-character excerpt."}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.sent_at IS '{"description":"Saved sent timestamp; not proof of current delivery."}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.created_at IS '{"description":"Record creation time.","nullable":false}';
COMMENT ON COLUMN meri_private.client_outreach_campaigns.updated_at IS '{"description":"Record update time.","nullable":false}';
COMMENT ON VIEW meri_private.client_campaign_recipients IS '{"description":"Saved EngagementCampaignRecipient rows joined through their same-tenant visible campaign.","grain":"One saved recipient row per id within its currently visible campaign and client.","primaryKey":["client_id","id"],"relationships":[{"fields":["client_id"],"referencedRelation":"client_profiles","referencedFields":["client_id"],"cardinality":"many_to_one","integrity":"enforced"},{"fields":["client_id","campaign_id"],"referencedRelation":"client_outreach_campaigns","referencedFields":["client_id","id"],"cardinality":"many_to_one","integrity":"enforced"}],"limitations":["Only current nonarchived clients and current wall grants are visible. SQL filters and row/byte limits do not establish complete saved-work coverage.","Same-tenant parent linkage is mandatory. Duplicate email/name rows are preserved. Raw metadata and external contact-directory records are excluded.","Joining recipients expands campaign rows; aggregate parents before joining when counting campaigns. Counts of recipients are not delivery counts."],"freshnessField":"created_at"}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.client_id IS '{"description":"Canonical current visible client ID; include it in joins.","nullable":false}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.id IS '{"description":"Canonical campaign recipient row ID.","nullable":false}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.campaign_id IS '{"description":"Canonical parent EngagementCampaign ID; join with client_id.","nullable":false}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.name IS '{"description":"Saved recipient name."}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.email IS '{"description":"Saved recipient email; not a generic identity-directory read.","nullable":false}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.title IS '{"description":"Saved recipient title."}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.office IS '{"description":"Saved recipient office."}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.status IS '{"description":"Saved recipient status, not fresh provider delivery evidence.","nullable":false}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.sent_at IS '{"description":"Saved sent timestamp."}';
COMMENT ON COLUMN meri_private.client_campaign_recipients.created_at IS '{"description":"Recipient record creation time.","nullable":false}';
RESET ROLE;

COMMENT ON SCHEMA meri_public IS
  'Meri query_capiro_data public surface: logical projections of ingested public records, read only by capiro_analytics_ro.';
