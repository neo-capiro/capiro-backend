import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLIC_RELATION_NAMES } from './sql-statement-gate.js';

/**
 * The published metadata describe_capiro_data returns is stored as JSON view
 * and column comments by the capiro_data migrations. These tests read the
 * migration files themselves (no database): the comments must be valid JSON
 * in the shape sql-reader-connection.ts reads, and after the column-meaning
 * migration every public column must carry a meaning rather than its own name.
 */
const migrations = join(__dirname, '../../../prisma/migrations');
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

describe('capiro_data published metadata', () => {
  const published = viewColumns(surface);
  const before = comments(surface, 'meri_public');
  const after = comments(meaning, 'meri_public');

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
    for (const [key, column] of [...before.columns, ...after.columns]) {
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
      expect(key).toBeDefined();
    }
  });

  it('after the column-meaning migration no public column is described only by its own name', () => {
    const effective = new Map([...before.columns, ...after.columns]);
    for (const [relation, columns] of published) {
      for (const column of columns) {
        const meta = effective.get(`${relation}.${column}`);
        expect(meta).toBeDefined();
        expect((meta!.description as string).trim()).not.toBe(column);
        expect((meta!.description as string).length).toBeGreaterThan(column.length + 4);
      }
    }
  });

  it('states the value vocabularies and identifier formats the model needs for text-to-SQL', () => {
    const effective = new Map([...before.columns, ...after.columns]);
    expect(effective.get('congress_bills.id')!.description).toMatch(/<congress>-<bill_type>-<bill_number>, e\.g\. 119-hr-1234/);
    expect(effective.get('congress_bills.status')!.enum).toEqual(['introduced', 'committee', 'reported', 'rule_pending', 'rule_failed', 'floor', 'passed_chamber', 'resolving', 'to_president', 'enacted', 'failed', 'vetoed']);
    expect(effective.get('congress_members.chamber')!.enum).toEqual(['house', 'senate']);
    expect(effective.get('program_elements.appropriation_type')!.enum).toEqual(['RDT&E', 'PROC', 'OM']);
    expect(effective.get('congress_bills.bill_type')!.enum).toEqual(['hr', 's', 'hjres', 'sjres', 'hres', 'sres', 'hconres', 'sconres']);
    expect(effective.get('congress_bill_cosponsors.withdrawn_date')!.description).toMatch(/withdrawn_date IS NULL for active cosponsors/);
    expect(effective.get('program_element_budget_positions.position_cycle')!.description).toMatch(/pb_fy2026/);
    // Nullability stays what the surface migration declared for every column the meaning migration retouches.
    for (const [key, column] of after.columns) {
      const previous = before.columns.get(key)!;
      expect(column.nullable ?? true).toBe(previous.nullable ?? true);
      if ('enum' in previous) expect(column.enum).toEqual(previous.enum);
    }
    // The amount, quantity, value_kind and created_at comments of the position relations were already meaningful and are untouched.
    for (const relation of ['program_element_budget_positions', 'program_element_project_budget_positions'])
      for (const column of ['value_kind', 'amount', 'quantity', 'created_at']) expect(after.columns.has(`${relation}.${column}`)).toBe(false);
  });
});
