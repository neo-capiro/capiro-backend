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
const unquote = (value: string) => value.replace(/''/g, "'");

type Comments = { views: Map<string, Record<string, unknown>>; columns: Map<string, Record<string, unknown>> };
function comments(script: string, schema: 'meri_public' | 'meri_private'): Comments {
  const views = new Map<string, Record<string, unknown>>(), columns = new Map<string, Record<string, unknown>>();
  for (const m of script.matchAll(new RegExp(`COMMENT ON VIEW ${schema}\\.(\\w+) IS '((?:[^']|'')*)';`, 'g'))) views.set(m[1]!, JSON.parse(unquote(m[2]!)));
  for (const m of script.matchAll(new RegExp(`COMMENT ON COLUMN ${schema}\\.(\\w+)\\.(\\w+) IS '((?:[^']|'')*)';`, 'g')))
    columns.set(`${m[1]}.${m[2]}`, JSON.parse(unquote(m[3]!)));
  return { views, columns };
}
/** View columns as the CREATE VIEW statements publish them. */
function viewColumns(script: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const m of script.matchAll(/CREATE VIEW meri_public\.(\w+)\s*\nWITH[^\n]*\n\s*SELECT ([^\n]*)\n/g)) result.set(m[1]!, m[2]!.split(',').map((c) => c.trim()));
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
  const published = viewColumns(surface);
  const before = comments(surface, 'meri_public');
  const after = comments(meaning, 'meri_public');
  const effective = new Map([...before.columns, ...after.columns]);
  const describe_ = (key: string) => effective.get(key)!.description as string;

  it('describes exactly the eight public relations the statement gate names', () => {
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
