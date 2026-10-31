/** Curated public relations for authored SQL. The legacy QuerySpec registry is independent. */
export type PublicSqlType = 'string' | 'integer' | 'decimal' | 'boolean' | 'date' | 'timestamp';
export interface PublicSqlColumn { name: string; type: PublicSqlType; nullable: boolean; unit?: string }
export interface PublicSqlField extends PublicSqlColumn { description: string; parameterType?: 'UUID' }
export interface PublicSqlRelationship {
  fields: string[]; referencedRelation: string; referencedFields: string[];
  cardinality: 'many_to_one'; integrity: 'enforced' | 'soft';
}
export interface PublicSqlRelation {
  name: string; table: string; predicate?: string; description: string; fields: PublicSqlField[];
  primaryKey: string[]; relationships: PublicSqlRelationship[]; grain: string;
  coverage: { basis: 'ingested_public_records'; limitations: string[] };
  freshness: { field: string | null; sourceAsOf: null; sourceVersion: null };
}
export const PUBLIC_SQL_LIMITS = Object.freeze({
  defaultRowLimit: 200, maxRowLimit: 1000, maxOutputBytes: 262144,
  maxSqlBytes: 16384, maxParameters: 64, maxParameterBytes: 32768, maxColumns: 32,
});
const f = (name: string, type: PublicSqlType = 'string', nullable = false, description = name, unit?: string): PublicSqlField =>
  ({ name, type, nullable, description, ...(unit ? { unit } : {}) });
const uuid = (name: string, nullable = false): PublicSqlField => ({ ...f(name, 'string', nullable), parameterType: 'UUID' });
const rel = (fields: string[], referencedRelation: string, referencedFields: string[], integrity: 'enforced' | 'soft' = 'enforced'): PublicSqlRelationship =>
  ({ fields, referencedRelation, referencedFields, cardinality: 'many_to_one', integrity });
const unknown = 'Published metadata does not establish active grants, populated rows, ingestion completeness or source freshness.';
// Hearing storage views enforce public/canonical rows as well as the curated columns.
// DB definitions and privileges are an explicit deployment dependency; no raw-table fallback.
const budgetLimit = 'Position cycle identifies the asserting book/stage; asserted FY identifies the year funded. PB outyears are not that future year’s submitted request. Filter value_kind and cycle before summing. Use the PE timeline for consolidated/current/enacted funding.';
const budgetFields = (): PublicSqlField[] => [
  f('position_cycle', 'string', false, 'Budget book/stage that asserted this amount, e.g. pb_fy2026.'),
  f('asserted_fy', 'integer', false, 'Fiscal year FOR which this position asserts a value.'),
  f('value_kind', 'string', false, 'total, quantity or (PE only) unit_cost; never combine different kinds.'),
  f('amount', 'decimal', false, 'total: USD millions; quantity: units; unit_cost: USD millions per unit.', 'value_kind dependent'),
  f('quantity', 'decimal', true, 'Reported quantity when available.', 'units'),
  f('source_url', 'string', true), f('page_number', 'integer', true), uuid('source_document_id', true),
  f('created_at', 'timestamp', false, 'Stored row creation time, not source freshness.'),
];
function relation(name: string, table: string, description: string, fields: PublicSqlField[], primaryKey: string[],
  relationships: PublicSqlRelationship[], limitations: string[] = [], freshness: string | null = 'last_synced_at', predicate?: string): PublicSqlRelation {
  return { name, table, description, fields, primaryKey, relationships, grain: `One row per (${primaryKey.join(', ')}).`,
    coverage: { basis: 'ingested_public_records', limitations: [unknown, ...limitations] },
    freshness: { field: freshness, sourceAsOf: null, sourceVersion: null }, ...(predicate ? { predicate } : {}) };
}
export const PUBLIC_SQL_RELATIONS: readonly PublicSqlRelation[] = [
  relation('congress_bills', 'congress_bill', 'Canonical federal bills; id includes Congress, bill type and number.', [
    f('id'), f('congress', 'integer'), f('bill_type'), f('bill_number'), f('title'), f('policy_area', 'string', true),
    f('status', 'string', true), f('status_at', 'timestamp', true), f('sponsor_bioguide_id', 'string', true),
    f('sponsor_name', 'string', true), f('sponsor_state', 'string', true), f('sponsor_party', 'string', true),
    f('introduced_date', 'date', true), f('latest_action_date', 'date', true), f('url', 'string', true),
    f('update_date', 'timestamp', true), f('last_synced_at', 'timestamp'),
  ], ['id'], [rel(['sponsor_bioguide_id'], 'congress_members', ['bioguide_id'], 'soft')], ['Sponsor display name is not an identity key; member resolution can be absent.']),
  relation('congress_bill_subjects', 'congress_bill_subject', 'Named subject assertions associated with canonical bill IDs.',
    [f('id'), f('bill_id'), f('name')], ['id'], [rel(['bill_id'], 'congress_bills', ['id'])],
    ['(bill_id, name) is not unique. Deduplicate bill IDs before counting bills.'], null),
  relation('congress_bill_cosponsors', 'congress_bill_cosponsor', 'Named cosponsors, including withdrawn sponsorships.', [
    f('bill_id'), f('bioguide_id'), f('full_name'), f('party', 'string', true), f('state', 'string', true),
    f('district', 'integer', true), f('sponsorship_date', 'date', true), f('is_original', 'boolean'),
    f('withdrawn_date', 'date', true), f('last_synced_at', 'timestamp'),
  ], ['bill_id', 'bioguide_id'], [rel(['bill_id'], 'congress_bills', ['id']), rel(['bioguide_id'], 'congress_members', ['bioguide_id'], 'soft')],
  ['Use withdrawn_date IS NULL for active cosponsors. A missing member row does not remove the canonical cosponsor ID.']),
  relation('congress_members', 'congress_member', 'Canonical Bioguide member roster.', [
    f('bioguide_id'), f('full_name'), f('party', 'string', true), f('state', 'string', true), f('district', 'integer', true),
    f('chamber'), f('is_current', 'boolean'), f('update_date', 'timestamp', true), f('last_synced_at', 'timestamp'),
  ], ['bioguide_id'], [], ['Current roster status does not establish historic membership. Names are not unique.']),
  relation('program_elements', 'program_element', 'Active public DoD program elements and procurement budget lines.', [
    f('pe_code'), f('title'), f('description', 'string', true), f('service', 'string', true), f('service_code', 'string', true),
    f('appropriation_type', 'string', true), f('budget_activity', 'string', true), f('program_of_record', 'string', true),
    f('source'), f('first_seen_fy', 'integer', true), f('last_synced_at', 'timestamp'),
  ], ['pe_code'], [], ['Retired records are excluded. Appropriation type distinguishes RDT&E PEs from procurement lines.'], 'last_synced_at', 'retired_at IS NULL'),
  relation('program_element_projects', 'program_element_project', 'Projects/sub-elements with mission narrative and nullable source locators.', [
    uuid('id'), f('pe_code'), f('project_code'), f('title'), f('mission', 'string', true), f('fy', 'integer', true), f('source'),
    f('source_url', 'string', true), f('page_number', 'integer', true), uuid('source_document_id', true), f('last_synced_at', 'timestamp'),
  ], ['pe_code', 'project_code'], [rel(['pe_code'], 'program_elements', ['pe_code'])], ['Several projects can match one PE; deduplicate PE IDs before aggregating parent funding.']),
  relation('program_element_budget_positions', 'program_element_budget_position', 'PE-level budget assertions, independent of project funding grain.',
    [uuid('id'), f('pe_code'), ...budgetFields()], ['pe_code', 'position_cycle', 'asserted_fy', 'value_kind'],
    [rel(['pe_code'], 'program_elements', ['pe_code'])], [budgetLimit, 'Joining multiple projects can multiply parent amounts; SUM(DISTINCT amount) also loses equal-valued parents.'], null),
  relation('program_element_project_budget_positions', 'program_element_project_budget_position', 'Project-level budget assertions; amount total is USD millions.',
    [uuid('id'), f('pe_code'), f('project_code'), ...budgetFields()], ['pe_code', 'project_code', 'position_cycle', 'asserted_fy', 'value_kind'],
    [rel(['pe_code'], 'program_elements', ['pe_code']), rel(['pe_code', 'project_code'], 'program_element_projects', ['pe_code', 'project_code'], 'soft')],
    [budgetLimit, 'Project value_kind supports total or quantity; project sums need not equal PE totals.'], null),
  relation('state_bills', 'state_bill', 'Canonical state bills; LegiScan bill spine with derived status and source locators.', [
    f('id', 'string', false, 'Canonical <state>-<sessionKey>-<billnumber> key, not an OpenStates ID.'),
    f('state'), f('session'), f('session_key'), f('identifier'), f('bill_number'), f('title'), f('chamber', 'string', true),
    f('status', 'string', true), f('status_at', 'timestamp', true), f('status_source', 'string', true),
    f('sponsor_name', 'string', true), f('sponsor_party', 'string', true), f('sponsor_count', 'integer'),
    f('latest_action_date', 'date', true), f('url', 'string', true), f('state_url', 'string', true),
    f('legiscan_bill_id', 'integer', true), f('source_checked_at', 'timestamp', true),
    f('source_check_status', 'string', true), f('synced_at', 'timestamp'),
  ], ['id'], [], [
    'State plus session_key plus bill_number defines identity; display session/identifier and sponsor names are not join keys.',
    'Status is derived. status_at is the legislative event time; synced_at is ingestion time, not proof of current official status.',
    'Use the bill source reader for decisive text or legal passages. Coverage varies by state and session.',
  ], 'synced_at'),
  relation('committee_hearings', 'meri_public_committee_hearings', 'Public canonical federal and state committee events, including hearings, markups and meetings.', [
    f('id', 'string', false, 'Stored hearing identity; text key, not necessarily a UUID.'),
    f('geographic_jurisdiction', 'string', true, 'US for federal; state code for state events. Legacy null is treated as federal by the existing reader.'),
    f('legislative_session', 'string', true), f('congress', 'integer', true), f('chamber'), f('committee_name'),
    f('committee_system_code', 'string', true), f('state_committee_id', 'string', true), f('title'), f('type', 'string', true),
    f('date', 'date', false, 'Stored calendar display day; not a scheduled instant.'),
    f('starts_at', 'timestamp', true, 'Authoritative scheduled UTC instant; null for date-only events. Never synthesize midnight.'),
    f('scheduled_end', 'timestamp', true), f('timezone'), f('time_precision', 'string', true), f('location', 'string', true),
    f('event_status'), f('url', 'string', true), f('source_revision', 'integer'),
    f('last_official_update_at', 'timestamp', true), f('calendar_revision', 'integer'),
    f('calendar_checked_at', 'timestamp', true), f('calendar_check_state'), f('synced_at', 'timestamp'),
  ], ['id'], [], [
    'Closed/private events and retained aliases are excluded. Counts are canonical public events, not unique bills or agenda assertions.',
    'Filter type and event_status explicitly; postponed/canceled events remain records. NULL starts_at does not mean midnight or cancellation.',
    'synced_at and calendar_checked_at are observation times; inspect calendar_check_state and last_official_update_at. No national/state calendar completeness is asserted.',
  ], 'synced_at'),
  relation('committee_hearing_bills', 'meri_public_committee_hearing_bills', 'Legacy federal bill agenda associations for public canonical committee events.', [
    f('id'), f('hearing_id'), f('bill_id'), f('congress', 'integer'), f('synced_at', 'timestamp'),
  ], ['id'], [rel(['hearing_id'], 'committee_hearings', ['id'], 'soft'), rel(['bill_id'], 'congress_bills', ['id'], 'soft')], [
    'One stored association per unique (hearing_id, bill_id); id is the row identity.',
    'Federal bill IDs are soft references; LEFT JOIN preserves an agenda association when the bill has not been ingested.',
    'One bill can appear at several events. Deduplicate bill_id before counting bills and hearing_id before counting events.',
    'This legacy association has no active/revision marker. Do not union its counts with legislative_agenda_items; current source-backed agendas use that relation.',
  ], 'synced_at'),
  relation('legislative_agenda_items', 'meri_public_legislative_agenda_items', 'Source-backed federal/state agenda assertions for public canonical committee events.', [
    uuid('id'), f('hearing_id'), f('item_key'), f('position', 'integer'), f('kind'), f('title'),
    f('bill_scope', 'string', true), f('state_bill_key', 'string', true), f('federal_bill_id', 'string', true),
    f('source_url'), f('active', 'boolean'), f('revision', 'integer'),
    f('first_seen_at', 'timestamp'), f('last_seen_at', 'timestamp'),
  ], ['id'], [
    rel(['hearing_id'], 'committee_hearings', ['id'], 'soft'), rel(['state_bill_key'], 'state_bills', ['id'], 'soft'),
    rel(['federal_bill_id'], 'congress_bills', ['id'], 'soft'),
  ], [
    'One stored assertion per unique (hearing_id, item_key); item_key alone is not an event-independent identity.',
    'Filter active=true for current agenda membership and bill_scope for state/federal bills. Non-bill items and withdrawn assertions are retained.',
    'State and federal keys are separate namespaces; never join a state key to congress_bills. Bill references are soft and may lack a local bill row.',
    'An agenda item is not a unique bill or hearing. Deduplicate the intended canonical key before aggregation; do not add legacy association counts.',
  ], 'last_seen_at'),
  relation('state_bill_calendar_events', 'meri_public_state_bill_calendar_events', 'Per-bill LegiScan calendar assertions: hearings, executive sessions and floor events.', [
    uuid('id'), f('bill_key'), f('event_key'), f('event_type'), f('date', 'date'),
    f('time', 'string', true, 'Source wall-clock text; no authoritative timezone or instant is available in this relation.'),
    f('location', 'string', true), f('present', 'boolean'), f('first_seen_at', 'timestamp'), f('last_synced_at', 'timestamp'),
  ], ['id'], [rel(['bill_key'], 'state_bills', ['id'])], [
    'One stored assertion per unique (bill_key, event_key); id is a storage row identity and can change on source recreation.',
    'This is a per-bill assertion, not a canonical hearing. A shared event can appear for several bills; do not sum it with committee_hearings.',
    'Filter present=true for currently observed assertions and event_type explicitly. Missing rows are not evidence of no hearing.',
    'event_key is scoped to bill_key. Join state_bills for jurisdiction, session and source URLs. A date and time string cannot establish a UTC instant.',
  ]),
  relation('federal_grants', 'federal_grant', 'Grants.gov opportunities and forecasts, not awarded grants or obligations.', [
    f('id', 'string', false, 'Grants.gov opportunity ID.'), f('title'), f('agency'), f('sub_agency', 'string', true),
    f('opportunity_number', 'string', true), f('category', 'string', true), f('funding_instrument', 'string', true),
    f('status', 'string', true), f('doc_type', 'string', true),
    f('award_ceiling', 'decimal', true, 'Published maximum potential award, stored as floating point; not an actual award.', 'USD'),
    f('award_floor', 'decimal', true, 'Published minimum potential award, stored as floating point; not an actual award.', 'USD'),
    f('estimated_funding', 'decimal', true, 'Estimated opportunity/program funding, stored as floating point; not obligations or expenditures.', 'USD'),
    f('expected_awards', 'integer', true), f('open_date', 'date', true), f('close_date', 'date', true),
    f('response_date_desc', 'string', true, 'Source close-date qualifiers, including continuous/TBD/time cutoffs; never infer from the date alone.'),
    f('cost_sharing', 'boolean', true), f('revision', 'integer', true), f('url', 'string', true),
    f('last_updated_at', 'timestamp', true), f('detail_synced_at', 'timestamp', true), f('synced_at', 'timestamp'),
  ], ['id'], [], [
    'synopsis and forecast have different source/date semantics. Filter doc_type/status; forecasts are not open application windows or commitments.',
    'Dates and close-date qualifiers must be interpreted together. A posted status alone does not prove the response window is open.',
    'USD opportunity estimates/ceilings/floors are not awarded dollars and cannot be combined as award totals. Source Float storage is not exact monetary accounting.',
    'No fiscal year is inferred from open/close dates. synced_at is ingestion time; last_updated_at is nullable source metadata.',
  ], 'synced_at'),
  relation('sam_opportunities', 'sam_opportunity', 'SAM.gov public procurement notices; notice identity is not contract or award identity.', [
    uuid('id'), f('notice_id'), f('solicitation_number', 'string', true), f('title'), f('notice_type'), f('base_type', 'string', true),
    f('agency', 'string', true), f('sub_agency', 'string', true), f('office', 'string', true),
    f('set_aside', 'string', true), f('set_aside_code', 'string', true), f('naics_code', 'string', true), f('psc_code', 'string', true),
    f('posted_date', 'timestamp', true), f('response_deadline', 'timestamp', true), f('archive_date', 'timestamp', true),
    f('active', 'boolean'), f('source_url', 'string', true), f('last_synced_at', 'timestamp'),
  ], ['notice_id'], [], [
    'Count notices, not distinct solicitations/contracts/awards. solicitation_number is nullable and not a canonical join key.',
    'notice_type is the current type; base_type is the original type. Sources Sought, Presolicitation and Award Notice are not open solicitations.',
    'active tracks archive state, not whether responses are still accepted. Inspect notice_type, response_deadline and archive_date together.',
    'NULL set_aside can mean full and open OR not stated. NULL sub_agency means not supplied. No award amount or fiscal-year inference is supported.',
  ]),
];
export function publicSqlRelation(name: string): PublicSqlRelation | undefined {
  return PUBLIC_SQL_RELATIONS.find((relation) => relation.name === name);
}
