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
];
export function publicSqlRelation(name: string): PublicSqlRelation | undefined {
  return PUBLIC_SQL_RELATIONS.find((relation) => relation.name === name);
}
