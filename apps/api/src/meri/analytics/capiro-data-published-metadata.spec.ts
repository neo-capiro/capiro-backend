import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_RELATION_NAMES } from './sql-statement-gate.js';

/**
 * The published metadata describe_capiro_data returns is stored as JSON view
 * and column comments by the capiro_data migrations. These tests read the
 * migration files themselves (no database): the comments must be valid JSON
 * in the shape sql-reader-connection.ts reads, every public column must carry
 * a meaning rather than its own name, and every claim about a stored form or
 * vocabulary is checked against the writer code that stores it and against
 * recorded Congress.gov payloads of the shape those writers store verbatim.
 */
const api = join(__dirname, '../../..');
const migrations = join(api, 'prisma/migrations');
const read = (path: string) => readFileSync(join(api, path), 'utf8');
const surface = readFileSync(join(migrations, '20281101010000_capiro_data_published_surface/migration.sql'), 'utf8');
const meaning = readFileSync(join(migrations, '20281101180000_capiro_data_public_column_meaning/migration.sql'), 'utf8');
const awards = readFileSync(join(migrations, '20281102100000_capiro_data_federal_awards_surface/migration.sql'), 'utf8');
const years = readFileSync(join(migrations, '20281102120000_capiro_data_program_element_years_surface/migration.sql'), 'utf8');
const grantsNotices = readFileSync(join(migrations, '20281102140000_capiro_data_grants_notices_surface/migration.sql'), 'utf8');
const forecasts = readFileSync(join(migrations, '20281102150000_capiro_data_government_forecasts_surface/migration.sql'), 'utf8');
const noticeMeaning = readFileSync(join(migrations, '20281102170000_capiro_data_sam_notice_column_meaning/migration.sql'), 'utf8');
const prismaSchema = readFileSync(join(api, 'prisma/schema.prisma'), 'utf8');
/** Column names of one Prisma model as the database spells them (`@map` or the field name). */
function modelColumns(model: string): Set<string> {
  const block = new RegExp(`\\r?\\nmodel ${model} \\{\\r?\\n([\\s\\S]*?)\\r?\\n\\}`).exec(prismaSchema)!;
  const columns = new Set<string>();
  for (const line of block[1]!.split(/\r?\n/)) {
    const field = /^\s+([A-Za-z]\w*)\s+\S/.exec(line);
    if (!field || line.trim().startsWith('//') || line.trim().startsWith('@@')) continue;
    columns.add(/@map\("(\w+)"\)/.exec(line)?.[1] ?? field[1]!);
  }
  return columns;
}
/** Column names of one raw-SQL table (CREATE TABLE in a migration, no Prisma model). */
function tableColumns(script: string, table: string): Set<string> {
  const block = new RegExp(`CREATE TABLE ${table} \\(\\n([\\s\\S]*?)\\n\\);`).exec(script)!;
  return new Set(block[1]!.split('\n').map((line) => /^\s+(\w+) \w+/.exec(line)?.[1]).filter((name): name is string => !!name && !['CHECK', 'PRIMARY', 'FOREIGN', 'UNIQUE'].includes(name)));
}
const unquote = (value: string) => value.replace(/''/g, "'");

type Comments = { views: Map<string, Record<string, unknown>>; columns: Map<string, Record<string, unknown>> };
function comments(script: string, schema: 'meri_public' | 'meri_private'): Comments {
  const views = new Map<string, Record<string, unknown>>(), columns = new Map<string, Record<string, unknown>>();
  for (const m of script.matchAll(new RegExp(`COMMENT ON VIEW ${schema}\\.(\\w+) IS '((?:[^']|'')*)';`, 'g'))) views.set(m[1]!, JSON.parse(unquote(m[2]!)));
  for (const m of script.matchAll(new RegExp(`COMMENT ON COLUMN ${schema}\\.(\\w+)\\.(\\w+) IS '((?:[^']|'')*)';`, 'g')))
    columns.set(`${m[1]}.${m[2]}`, JSON.parse(unquote(m[3]!)));
  return { views, columns };
}
/** Splits a select list at top-level commas only, so `NULLIF(array_to_string(a, '; '), '')` stays one entry. */
function selectEntries(list: string): string[] {
  const entries: string[] = [];
  let depth = 0, quoted = false, current = '';
  for (const char of list) {
    if (char === "'") quoted = !quoted;
    if (!quoted && char === '(') depth++;
    if (!quoted && char === ')') depth--;
    if (!quoted && depth === 0 && char === ',') { entries.push(current.trim()); current = ''; continue; }
    current += char;
  }
  return [...entries, current.trim()];
}
/** View columns as the CREATE VIEW statements publish them. */
function viewColumns(script: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  // A select-list entry publishes its alias when it has one (`contractor_name AS recipient_name`).
  for (const m of script.matchAll(/CREATE VIEW meri_public\.(\w+)\s*\nWITH[^\n]*\n\s*SELECT ([^\n]*)\n/g))
    result.set(m[1]!, selectEntries(m[2]!).map((c) => c.split(/\s+AS\s+/i).pop()!));
  return result;
}

/**
 * Congress.gov payloads recorded on 1 November 2026 (api.congress.gov/v3 member list, bill 119/hr/1 sponsors, bill
 * 119/s/5 cosponsors, member list for AK). The writers below store these fields verbatim, so their forms are the stored forms.
 */
const CONGRESS_GOV = {
  members: [
    { name: 'Warren, Elizabeth', partyName: 'Democratic', state: 'Massachusetts', chamber: 'Senate' },
    { name: 'Begich, Nicholas J.', partyName: 'Republican', state: 'Alaska', chamber: 'House of Representatives' }, // at-large: no district key
  ],
  sponsor: { fullName: 'Rep. Arrington, Jodey C. [R-TX-19]', party: 'R', state: 'TX', district: 19 },
  cosponsor: { fullName: 'Sen. Risch, James E. [R-ID]', party: 'R', state: 'ID' },
};

describe('capiro_data published metadata', () => {
  const published = new Map([...viewColumns(surface), ...viewColumns(awards), ...viewColumns(years), ...viewColumns(grantsNotices), ...viewColumns(forecasts)]);
  const surfaceComments = comments(surface, 'meri_public'), awardComments = comments(awards, 'meri_public'), yearComments = comments(years, 'meri_public');
  // The notice column-meaning migration replaces comments of 20281102140000; later comments win.
  const firstNoticeComments = comments(grantsNotices, 'meri_public'), noticeCorrections = comments(noticeMeaning, 'meri_public');
  const grantNoticeComments: Comments = {
    views: new Map([...firstNoticeComments.views, ...noticeCorrections.views]),
    columns: new Map([...firstNoticeComments.columns, ...noticeCorrections.columns]),
  };
  const forecastComments = comments(forecasts, 'meri_public');
  const before: Comments = {
    views: new Map([...surfaceComments.views, ...awardComments.views, ...yearComments.views, ...grantNoticeComments.views, ...forecastComments.views]),
    columns: new Map([...surfaceComments.columns, ...awardComments.columns, ...yearComments.columns, ...grantNoticeComments.columns, ...forecastComments.columns]),
  };
  const after = comments(meaning, 'meri_public');
  const effective = new Map([...before.columns, ...after.columns]);
  const describe_ = (key: string) => effective.get(key)!.description as string;

  it('publishes federal awards and assistance awards from the writers\' columns, with the recipient name and a stable key', () => {
    expect(awards).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(awards).toMatch(/GRANT SELECT ON TABLE meri_public\.federal_awards, meri_public\.federal_assistance_awards TO capiro_analytics_ro;/);
    expect(awards).not.toMatch(/REVOKE|DROP|ALTER TABLE/);
    // The aliased recipient name is federal_award.contractor_name; every other published column exists on the base table.
    const contract = modelColumns('FederalAward'), assistance = modelColumns('FederalAssistanceAward');
    for (const column of published.get('federal_awards')!) expect(contract.has(column === 'recipient_name' ? 'contractor_name' : column)).toBe(true);
    for (const column of published.get('federal_assistance_awards')!) expect(assistance.has(column)).toBe(true);
    expect(awards).toMatch(/contractor_name AS recipient_name/);
    for (const name of ['federal_awards', 'federal_assistance_awards']) {
      const view = before.views.get(name)!;
      expect(view.primaryKey).toEqual(['award_unique_id']);
      expect(view.freshnessField).toBe('last_synced_at');
      expect(view.description).toMatch(/GROUP BY recipient_name/);
      expect(before.columns.get(`${name}.recipient_name`)!.description).toMatch(/as published .*group by recipient_uei/);
    }
    expect(before.views.get('federal_awards')!.relationships).toEqual([{ fields: ['pe_code'], referencedRelation: 'program_elements', referencedFields: ['pe_code'], cardinality: 'many_to_one', integrity: 'soft' }]);
    expect(before.columns.get('federal_awards.amount')!.unit).toBe('USD');
    expect(before.columns.get('federal_assistance_awards.total_obligated_amount')!.unit).toBe('USD');
    expect(before.columns.get('federal_assistance_awards.award_type_code')!.enum).toEqual(['02', '03', '04', '05']);
  });

  it('publishes PE funding by fiscal year from program_element_year, in USD millions per stage, and marks the budget-position relations unpopulated', () => {
    expect(years).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(years).toMatch(/GRANT SELECT ON TABLE meri_public\.program_element_years TO capiro_analytics_ro;/);
    expect(years).not.toMatch(/REVOKE|DROP|ALTER TABLE|CREATE OR REPLACE/);
    const model = modelColumns('ProgramElementYear');
    const columns = published.get('program_element_years')!;
    for (const column of columns) expect(model.has(column)).toBe(true);
    for (const storage of ['notes', 'r_doc_section', 'raw_jsonb', 'id']) expect(columns).not.toContain(storage);
    // Active PEs only, like program_elements, so the enforced relationship never dangles.
    expect(years).toMatch(/FROM public\.program_element_year\nWHERE EXISTS \(SELECT 1 FROM public\.program_element pe WHERE pe\.pe_code = program_element_year\.pe_code AND pe\.retired_at IS NULL\);/);
    const view = before.views.get('program_element_years')!;
    expect(view.primaryKey).toEqual(['pe_code', 'fy']);
    expect(view.freshnessField).toBe('last_synced_at');
    expect(view.relationships).toEqual([{ fields: ['pe_code'], referencedRelation: 'program_elements', referencedFields: ['pe_code'], cardinality: 'many_to_one', integrity: 'enforced' }]);
    expect(view.description).toMatch(/USD millions/);
    expect((view.limitations as string[]).join(' ')).toMatch(/never summed across stages/);
    // Every money column states the unit the loaders store (program-element-read.service.ts reports the same values as USD millions).
    for (const money of ['request', 'hasc_mark', 'sasc_mark', 'hac_d_mark', 'sac_d_mark', 'ndaa_conference', 'conference', 'enacted', 'reprogrammed', 'executed']) {
      expect(columns).toContain(money);
      expect(before.columns.get(`program_element_years.${money}`)!.unit).toBe('USD millions');
    }
    for (const key of ['pe_code', 'fy', 'last_synced_at']) expect(before.columns.get(`program_element_years.${key}`)!.nullable).toBe(false);
    // The budget-position views keep their definitions; only a limitation is appended, naming where funding by FY lives.
    expect(years).toMatch(/ARRAY\['program_element_budget_positions', 'program_element_project_budget_positions'\]/);
    expect(years).toMatch(/jsonb_set\(current_comment, '\{limitations\}'/);
    expect(years).toMatch(/expected to hold no rows; when a query over it returns nothing, state that budget position amounts are not loaded and use program_element_years or the PE budget timeline read/);
    expect(years).toMatch(/Never estimate an amount\./);
    expect(years).not.toMatch(/CREATE VIEW meri_public\.program_element_budget_positions/);
  });

  it('publishes grant opportunities and SAM notices with stable public keys, the writer vocabularies and no private or raw columns', () => {
    expect(grantsNotices).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(grantsNotices).toMatch(/GRANT SELECT ON TABLE meri_public\.federal_grants, meri_public\.sam_opportunities TO capiro_analytics_ro;/);
    expect(grantsNotices).not.toMatch(/REVOKE|DROP|ALTER TABLE|CREATE OR REPLACE/);
    const grant = modelColumns('FederalGrant'), notice = modelColumns('SamOpportunity');
    // Every published column is a stored column, or a declared derivation of one (array joined with '; ', JSON state code).
    const derivedFrom: Record<string, string> = { grants_gov_id: 'id', eligibility: 'eligibility', assistance_listing_numbers: 'cfda_numbers', pop_state: 'place_of_performance_jsonb' };
    for (const column of published.get('federal_grants')!) expect(grant.has(derivedFrom[column] ?? column)).toBe(true);
    for (const column of published.get('sam_opportunities')!) expect(notice.has(derivedFrom[column] ?? column)).toBe(true);
    for (const hidden of ['raw', 'raw_jsonb', 'embedded_content_hash', 'embedded_at', 'detail_synced_at', 'tenant_id', 'id', 'poc_name', 'poc_email', 'place_of_performance_jsonb', 'cfda_numbers'])
      for (const name of ['federal_grants', 'sam_opportunities']) expect(published.get(name)).not.toContain(hidden);
    expect(grantsNotices).toMatch(/SELECT id AS grants_gov_id, /);
    expect(before.views.get('federal_grants')!.primaryKey).toEqual(['grants_gov_id']);
    expect(before.views.get('sam_opportunities')!.primaryKey).toEqual(['notice_id']);
    expect(before.views.get('federal_grants')!.freshnessField).toBe('synced_at');
    expect(before.views.get('sam_opportunities')!.freshnessField).toBe('last_synced_at');
    // Open is the writers' and readers' predicate: status posted or forecasted with a null or future close date
    // (funding-catalog.reconcile.ts, district-nexus isOpportunityActive); a null close date is not closed.
    const mapper = read('src/external/tango/funding-catalog.mapper.ts'), reconcile = read('src/external/tango/funding-catalog.reconcile.ts');
    expect(mapper).toMatch(/\{ P: 'posted', F: 'forecasted', C: 'closed', A: 'archived' \}/);
    expect(reconcile).toMatch(/status IN \('posted','forecasted'\)/);
    expect(reconcile).toMatch(/close_date IS NULL OR close_date >= /);
    expect(before.columns.get('federal_grants.status')!.enum).toEqual(['posted', 'forecasted', 'closed', 'archived']);
    expect(before.views.get('federal_grants')!.description).toMatch(/Open means status posted or forecasted and close_date null or today or later/);
    expect(before.columns.get('federal_grants.close_date')!.description).toMatch(/May be null/);
    expect(mapper).toMatch(/docType: status === 'forecasted' \? 'forecast' : 'synopsis'/);
    expect(before.columns.get('federal_grants.doc_type')!.enum).toEqual(['synopsis', 'forecast']);
    expect(mapper).toMatch(/url: `https:\/\/www\.grants\.gov\/search-results-detail\/\$\{row\.grant_id\}`/);
    for (const money of ['award_ceiling', 'award_floor', 'estimated_funding']) expect(before.columns.get(`federal_grants.${money}`)!.unit).toBe('USD');
    // Notices: 32-hex key, the SAM URL form, and active is the archive flag, not the response window.
    expect(mapper).toMatch(/\/\^\[a-f0-9\]\{32\}\$\//);
    expect(mapper).toMatch(/sourceUrl: `https:\/\/sam\.gov\/opp\/\$\{id\}\/view`/);
    expect(before.columns.get('sam_opportunities.notice_id')!.description).toMatch(/32 lowercase hexadecimal characters/);
    expect(before.columns.get('sam_opportunities.active')!.description).toMatch(/an active notice can be past its response_deadline/);
    // The current writer stores the provider's active flag and never sets base_type or archive_date.
    expect(mapper).toMatch(/active: typeof row\.active === 'boolean' \? row\.active : undefined/);
    const noticeWriter = /export function noticeFields[\s\S]*?\r?\n\}/.exec(mapper)![0];
    expect(noticeWriter).not.toMatch(/baseType|archiveDate|base_type|archive_date/);
    expect(before.columns.get('sam_opportunities.active')!.description).toMatch(/provider's active flag .* not computed from archive_date/);
    for (const column of ['base_type', 'archive_date'])
      expect(before.columns.get(`sam_opportunities.${column}`)!.description).toMatch(/null on every notice the current writer loads/);
    expect((before.views.get('sam_opportunities')!.limitations as string[]).join(' ')).toMatch(/base_type and archive_date are null on every notice the current writer loads/);
    expect((before.views.get('sam_opportunities')!.limitations as string[]).join(' ')).not.toMatch(/follows the archive date/);
    // Comments only, on this one view, under the projection owner.
    expect(noticeMeaning).not.toMatch(/CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE/);
    expect([...noticeCorrections.views.keys()]).toEqual(['sam_opportunities']);
    expect([...noticeCorrections.columns.keys()].sort()).toEqual(['sam_opportunities.active', 'sam_opportunities.archive_date', 'sam_opportunities.base_type']);
    expect(noticeMeaning).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(noticeMeaning.trim().endsWith('RESET ROLE;')).toBe(true);
    expect(mapper).toMatch(/fullNoticeType\.slice\(0, 32\)/);
    expect(before.columns.get('sam_opportunities.notice_type')!.description).toMatch(/truncated to 32 characters/);
    for (const code of ['SBA', 'SDVOSBC', '8AN', 'WOSB', 'HZC']) expect(mapper).toContain(`'${code}'`);
  });

  it('publishes Unified Agenda forecasts from the head and its current revision content, with the Core read\'s window semantics', () => {
    expect(forecasts).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(forecasts).toMatch(/GRANT SELECT ON TABLE meri_public\.government_forecasts TO capiro_analytics_ro;/);
    expect(forecasts).not.toMatch(/REVOKE|DROP|ALTER TABLE|CREATE OR REPLACE/);
    const windows = read('prisma/migrations/20281101120000_government_forecast_windows/migration.sql');
    const head = tableColumns(windows, 'government_forecast'), revision = tableColumns(windows, 'government_forecast_revision');
    const columns = published.get('government_forecasts')!;
    // Every published column is a stored head column (id and current_revision renamed) or one text member of the revision's content JSON.
    const storedAs: Record<string, string> = { forecast_id: 'id', revision: 'current_revision', title: 'content', event_type: 'content', period_precision: 'content', period_text: 'content', edition: 'content', source_url: 'content' };
    for (const column of columns) expect(head.has(storedAs[column] ?? column) || revision.has(storedAs[column] ?? column)).toBe(true);
    for (const hidden of ['id', 'source_key', 'content_hash', 'current_revision', 'content', 'source_xml', 'sha256']) expect(columns).not.toContain(hidden);
    // Exactly the rows the Core read serves: the head joined to its current revision (government-forecasts.service.ts).
    const service = read('src/government-forecasts/government-forecasts.service.ts');
    expect(forecasts).toMatch(/FROM public\.government_forecast f JOIN public\.government_forecast_revision r ON r\.forecast_id = f\.id AND r\.revision = f\.current_revision;/);
    expect(service).toMatch(/ON r\.forecast_id=f\.id AND r\.revision=f\.current_revision/);
    const view = before.views.get('government_forecasts')!;
    expect(view.primaryKey).toEqual(['forecast_id']);
    expect(view.freshnessField).toBe('observed_at');
    expect(view.relationships).toEqual([]);
    expect(view.description).toMatch(/rulemaking forecasts, not procurement or contract forecasts/);
    // The JSON members and their vocabularies are the writer's contract (forecast-contract.ts) and the head's CHECK constraint.
    const contract = read('src/government-forecasts/forecast-contract.ts');
    for (const member of ['title: string', "eventType: 'proposed_rule' | 'final_rule'", 'period: ForecastPeriod', 'source: ForecastSource']) expect(contract).toContain(`  ${member};`);
    expect(contract).toMatch(/\| \{ precision: 'month'; raw: string; year: number; month: number \}/);
    expect(contract).toMatch(/\| \{ precision: 'unknown'; raw: string \}/);
    expect(contract).toMatch(/interface ForecastSource \{\n  rin: string;\n  edition: string;\n  url: string;/);
    expect(before.columns.get('government_forecasts.event_type')!.enum).toEqual(['proposed_rule', 'final_rule']);
    expect(before.columns.get('government_forecasts.period_precision')!.enum).toEqual(['month', 'unknown']);
    expect(windows).toMatch(/status text NOT NULL DEFAULT 'published' CHECK \(status IN \('published', 'withdrawn', 'source_completed'\)\)/);
    expect(before.columns.get('government_forecasts.status')!.enum).toEqual(['published', 'withdrawn', 'source_completed']);
    // The window is the civil month with an exclusive upper bound (monthBounds), and overlap is the Core read's own predicate.
    expect(contract).toContain("const to = `${month === 12 ? year + 1 : year}-${String(month === 12 ? 1 : month + 1).padStart(2, '0')}-01`;");
    expect(windows).toMatch(/\(window_from IS NOT NULL AND window_to IS NOT NULL AND window_from < window_to\)/);
    expect(service).toMatch(/f\.window_from < \$\{q\.to\}::date AND f\.window_to > \$\{q\.from\}::date/);
    expect(view.description).toMatch(/window_from < b AND window_to > a/);
    expect(before.columns.get('government_forecasts.window_to')!.description).toMatch(/exclusive/);
    expect(before.columns.get('government_forecasts.window_from')!.description).toMatch(/null when no month was determinable/);
    for (const key of ['forecast_id', 'rin', 'status', 'revision', 'recorded_at']) expect(before.columns.get(`government_forecasts.${key}`)!.nullable).toBe(false);
  });

  it('describes exactly the public relations the statement gate names', () => {
    expect([...published.keys()].sort()).toEqual([...PUBLIC_RELATION_NAMES].sort());
    for (const name of PUBLIC_RELATION_NAMES) expect(before.views.has(name)).toBe(true);
    for (const name of after.views.keys()) expect(published.has(name)).toBe(true);
  });

  it('only comments columns the views publish, and touches no private relation', () => {
    for (const key of [...before.columns.keys(), ...after.columns.keys()]) {
      const [relation, column] = key.split('.');
      expect(published.get(relation!)).toContain(column);
    }
    expect(meaning).not.toMatch(/meri_private/);
    expect(meaning).toMatch(/^SET ROLE capiro_public_projection_owner;$/m);
    expect(meaning.trim().endsWith('RESET ROLE;')).toBe(true);
  });

  it('keeps every comment in the shape the reader connection parses', () => {
    for (const [name, view] of [...before.views, ...after.views]) {
      expect(Object.keys(view).sort()).toEqual(['description', 'freshnessField', 'grain', 'limitations', 'primaryKey', 'relationships']);
      expect(typeof view.description).toBe('string');
      expect(Array.isArray(view.primaryKey) && (view.primaryKey as unknown[]).length > 0).toBe(true);
      for (const key of view.primaryKey as string[]) expect(published.get(name)).toContain(key);
      for (const link of view.relationships as { fields: string[]; referencedRelation: string; referencedFields: string[]; integrity: string }[]) {
        expect(published.has(link.referencedRelation)).toBe(true);
        expect(link.fields.length).toBe(link.referencedFields.length);
        for (const field of link.fields) expect(published.get(name)).toContain(field);
        for (const field of link.referencedFields) expect(published.get(link.referencedRelation)).toContain(field);
        expect(['enforced', 'soft']).toContain(link.integrity);
      }
      expect(view.freshnessField === null || (published.get(name) ?? []).includes(view.freshnessField as string)).toBe(true);
    }
    for (const [, column] of [...before.columns, ...after.columns]) {
      for (const field of Object.keys(column)) expect(['description', 'nullable', 'enum', 'unit']).toContain(field);
      expect(typeof column.description).toBe('string');
      if ('nullable' in column) expect(typeof column.nullable).toBe('boolean');
      if ('unit' in column) expect(typeof column.unit).toBe('string');
      if ('enum' in column) {
        const values = column.enum as unknown[];
        expect(values.length).toBeGreaterThan(0);
        expect(new Set(values).size).toBe(values.length);
        for (const value of values) expect(typeof value).toBe('string');
      }
    }
  });

  it('after the column-meaning migration no public column is described only by its own name', () => {
    for (const [relation, columns] of published) {
      for (const column of columns) {
        const meta = effective.get(`${relation}.${column}`);
        expect(meta).toBeDefined();
        expect((meta!.description as string).trim()).not.toBe(column);
        expect((meta!.description as string).length).toBeGreaterThan(column.length + 4);
      }
    }
    // Nullability stays what the surface migration declared; the position relations' already meaningful comments are untouched.
    for (const [key, column] of after.columns) expect(column.nullable ?? true).toBe(before.columns.get(key)!.nullable ?? true);
    for (const relation of ['program_element_budget_positions', 'program_element_project_budget_positions'])
      for (const column of ['value_kind', 'amount', 'quantity', 'created_at']) expect(after.columns.has(`${relation}.${column}`)).toBe(false);
  });

  it('member party, state and name describe the forms sync-congress-members.ts stores (Congress.gov member list, verbatim)', () => {
    const writer = read('scripts/sync-congress-members.ts');
    expect(writer).toMatch(/party: m\.partyName \?\? null/);
    expect(writer).toMatch(/state: m\.state \?\? null/);
    expect(writer).toMatch(/fullName: m\.name \?\?/);
    expect(writer).toMatch(/district: typeof m\.district === 'number' \? m\.district : null/);
    expect(writer).toMatch(/\? 'senate' : 'house'/);
    for (const member of CONGRESS_GOV.members) {
      expect(describe_('congress_members.party')).toContain(member.partyName);
      expect(member.name).toMatch(/^[^,]+, /);
    }
    const [senator, atLarge] = CONGRESS_GOV.members;
    expect(describe_('congress_members.state')).toContain(senator!.state);
    expect('district' in atLarge!).toBe(false);
    expect(describe_('congress_members.district')).toContain(atLarge!.state);
    expect(describe_('congress_members.full_name')).toMatch(/Last, First, e\.g\. Warren, Elizabeth/);
    expect(describe_('congress_members.party')).toMatch(/one-letter codes \(D, R, I\) instead: WHERE party = 'D' matches nothing here/);
    expect(describe_('congress_members.state')).toMatch(/two-letter postal codes \(MA\) instead/);
    expect(describe_('congress_members.district')).toMatch(/null when Congress\.gov publishes none \(senators, and at-large House seats such as Alaska/);
    expect(effective.get('congress_members.chamber')!.enum).toEqual(['house', 'senate']);
    expect(effective.get('congress_members.party')!.enum).toBeUndefined();
    expect(effective.get('congress_members.state')!.enum).toBeUndefined();
  });

  it('bill sponsor and cosponsor party, state and name describe the forms sync-congress.ts stores (bill payloads, verbatim)', () => {
    const writer = read('scripts/sync-congress.ts');
    expect(writer).toMatch(/sponsorName: sponsor\?\.fullName \?\? null/);
    expect(writer).toMatch(/sponsorState: sponsor\?\.state \?\? null/);
    expect(writer).toMatch(/sponsorParty: sponsor\?\.party \?\? null/);
    expect(writer).toMatch(/fullName: c\.fullName \?\? ''/);
    expect(writer).toMatch(/party: c\.party \?\? null/);
    expect(writer).toMatch(/state: c\.state \?\? null/);
    const { sponsor, cosponsor } = CONGRESS_GOV;
    expect(describe_('congress_bills.sponsor_name')).toContain(sponsor.fullName);
    expect(describe_('congress_bills.sponsor_name')).toContain(cosponsor.fullName);
    expect(describe_('congress_bills.sponsor_party')).toMatch(new RegExp(`One-letter party code .* e\\.g\\. D, ${sponsor.party} or I`));
    expect(describe_('congress_bills.sponsor_state')).toMatch(new RegExp(`Two-letter postal code .* e\\.g\\. ${sponsor.state}`));
    expect(describe_('congress_bill_cosponsors.full_name')).toContain(cosponsor.fullName);
    expect(describe_('congress_bill_cosponsors.party')).toMatch(/One-letter party code .* e\.g\. D, R or I/);
    expect(describe_('congress_bill_cosponsors.state')).toMatch(new RegExp(`Two-letter postal code .* e\\.g\\. ${cosponsor.state}`));
    expect(describe_('congress_bill_cosponsors.district')).toContain(`e.g. ${sponsor.district}`);
    // Both sides of the code/name split say so, so the model maps instead of joining on text.
    for (const key of ['congress_bills.sponsor_party', 'congress_bill_cosponsors.party']) expect(describe_(key)).toMatch(/congress_members\.party is the party name \(Democratic, Republican, Independent\)/);
    for (const key of ['congress_bills.sponsor_state', 'congress_bill_cosponsors.state']) expect(describe_(key)).toMatch(/congress_members\.state is the full name/);
    expect((after.views.get('congress_bills')!.limitations as string[]).join(' ')).toMatch(/join members on bioguide_id, never on party or state text/);
  });

  it('status and bill type vocabularies match the writers; appropriation_type is free text and stays unenumerated', () => {
    const shared = read('../../packages/shared/src/index.ts');
    const union = /export type BillStatus =((?:\s*\|\s*'[a-z_]+')+);/.exec(shared)!;
    const stages = [...union[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(effective.get('congress_bills.status')!.enum).toEqual(stages);
    expect(shared).toMatch(/export function deriveBillStatus\(/);
    expect(meaning).toMatch(/deriveBillStatus/);
    expect(meaning).not.toMatch(/deriveBillStage/);
    expect(effective.get('congress_bills.bill_type')!.enum).toEqual(['hr', 's', 'hjres', 'sjres', 'hres', 'sres', 'hconres', 'sconres']);
    expect(describe_('congress_bills.id')).toMatch(/<congress>-<bill_type>-<bill_number>, e\.g\. 119-hr-1234/);
    expect(read('src/defense-budget/contracts/extraction-artifact-v1.ts')).toMatch(/appropriationType: z\.string\(\)\.optional\(\)/);
    expect(effective.get('program_elements.appropriation_type')!.enum).toBeUndefined();
    expect(describe_('program_elements.appropriation_type')).toMatch(/free text; values seen: RDT&E .* PROC .* OM/);
    expect(describe_('congress_bill_cosponsors.withdrawn_date')).toMatch(/withdrawn_date IS NULL for active cosponsors/);
    expect(describe_('program_element_budget_positions.position_cycle')).toMatch(/pb_fy2026/);
  });
});
