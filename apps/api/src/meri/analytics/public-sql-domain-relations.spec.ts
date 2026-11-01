import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { describeCapiroData, queryCapiroData } from './public-sql-query.js';
import { readPublishedSurface, translateDatabaseError, type PublishedRelation, type SqlResultColumn, type SqlResultRow } from './sql-reader-connection.js';
import { gateSqlStatement, PUBLIC_RELATION_NAMES, SqlQueryError, type SqlParameter } from './sql-statement-gate.js';

const additions = ['state_bills', 'committee_hearings', 'committee_hearing_bills', 'legislative_agenda_items',
  'state_bill_calendar_events', 'federal_grants', 'sam_opportunities'];
const migration = readFileSync(resolve(__dirname, '../../../prisma/migrations/20281101010000_capiro_data_published_surface/migration.sql'), 'utf8');
const schema = readFileSync(resolve(__dirname, '../../../prisma/schema.prisma'), 'utf8');
const views = [...migration.matchAll(/CREATE VIEW meri_public\.(\w+)\s+WITH \(security_barrier = true, security_invoker = false\) AS\s+SELECT ([\s\S]*?)\s+FROM public\.(\w+)([\s\S]*?);/g)]
  .map((match) => ({ name: match[1]!, columns: match[2]!.split(',').map((column) => column.trim()), table: match[3]!, predicate: match[4]!.trim() }));
const viewComments = new Map([...migration.matchAll(/COMMENT ON VIEW meri_public\.(\w+) IS '((?:[^']|'')*)';/g)]
  .map((match) => [match[1]!, match[2]!.replace(/''/g, "'")]));
const columnComments = new Map([...migration.matchAll(/COMMENT ON COLUMN meri_public\.(\w+)\.(\w+) IS '((?:[^']|'')*)';/g)]
  .map((match) => [`${match[1]}.${match[2]}`, match[3]!.replace(/''/g, "'")]));
function modelFields(table: string) {
  const block = [...schema.matchAll(/model \w+ \{([\s\S]*?)\n\}/g)]
    .map((match) => match[1]!).find((body) => body.includes(`@@map("${table}")`));
  if (!block) throw new Error(`Missing schema model for ${table}`);
  const fields = [...block.matchAll(/^\s+(\w+)\s+(String|Int|Float|Decimal|Boolean|DateTime)(\??)(\[\])?([^\n]*)/gm)]
    .map((match) => ({ name: match[1]!, type: match[2]!, nullable: match[3] === '?', array: !!match[4],
      attributes: match[5]!, column: /@map\("([^"]+)"\)/.exec(match[5]!)?.[1] ?? match[1]! }));
  return { block, fields };
}
function pgType(type: string, attributes: string): string {
  if (type === 'DateTime') return /\s@db\.Date(?:\s|$)/.test(attributes) ? 'date' : attributes.includes('@db.Timestamptz') ? 'timestamptz' : 'timestamp';
  if (type === 'String') return attributes.includes('@db.Uuid') ? 'uuid' : attributes.includes('@db.VarChar') ? 'varchar' : 'text';
  const types: Record<string, string> = { Int: 'int4', Float: 'float8', Decimal: 'numeric', Boolean: 'bool' };
  const value = types[type];
  if (!value) throw new Error(`Unsupported fixture scalar ${type}`);
  return value;
}

// Scripted pg_catalog rows use the committed view/column comments and schema scalar
// types. No connection is opened; actual grants remain the DB integration suite's proof.
async function publishedSurface() {
  const rows = views.flatMap((view) => view.columns.map((name) => {
    const field = modelFields(view.table).fields.find((entry) => entry.column === name);
    if (!field || field.array) throw new Error(`Non-scalar projection ${view.name}.${name}`);
    const comment = columnComments.get(`${view.name}.${name}`);
    if (!comment || !viewComments.has(view.name)) throw new Error('Missing published catalog comment');
    const typname = pgType(field.type, field.attributes);
    return { relation: view.name, relation_comment: viewComments.get(view.name), column_name: name,
      column_type: typname, typname, column_comment: comment };
  }));
  const client = Object.assign(new Client(), { release: jest.fn() });
  const query = jest.spyOn(client, 'query').mockImplementation(async () => ({ command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }));
  const surface = await readPublishedSurface(client, 'meri_public', 'ingested_public_records', PUBLIC_RELATION_NAMES);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_catalog.has_table_privilege(c.oid, 'SELECT')"), ['meri_public']);
  return surface;
}
const db = (surface: PublishedRelation[], rows: SqlResultRow[] = [], columns: SqlResultColumn[] = []) => ({
  describePublic: jest.fn(async () => surface), runPublicSql: jest.fn(async () => ({ columns, rows, surface })),
});

describe('public legislative and opportunity SQL coverage', () => {
  let surface: PublishedRelation[];
  beforeAll(async () => { surface = await publishedSurface(); });

  it.each(PUBLIC_RELATION_NAMES)('%s projects only schema-backed scalar columns with declared nullability and unique grain', (name) => {
    const relation = surface.find((entry) => entry.name === name)!;
    const view = views.find((entry) => entry.name === name)!;
    const { block, fields } = modelFields(view.table);
    expect(relation.fields.map((field) => field.name)).toEqual(view.columns);
    for (const field of relation.fields) {
      const physical = fields.find((entry) => entry.column === field.name)!;
      expect(physical.array).toBe(false);
      expect(field.nullable).toBe(physical.nullable);
      expect(field.pgType).toBe(pgType(physical.type, physical.attributes));
      const scalarTypes: Record<string, string> = { String: 'string', Int: 'integer', Float: 'decimal', Decimal: 'decimal', Boolean: 'boolean' };
      const expected = physical.type === 'DateTime' ? (/\s@db\.Date(?:\s|$)/.test(physical.attributes) ? 'date' : 'timestamp') : scalarTypes[physical.type];
      expect(field.type).toBe(expected);
    }
    const keys = relation.primaryKey.map((key) => fields.find((field) => field.column === key)!.name);
    expect(keys.length).toBeGreaterThan(0);
    const unique = keys.length === 1 && fields.some((field) => field.name === keys[0] && /@(id|unique)\b/.test(field.attributes));
    expect(unique || block.includes(`@@unique([${keys.join(', ')}]`)).toBe(true);
    const sql = `SELECT r.${relation.primaryKey[0]} FROM ${name} r`;
    const query = gateSqlStatement({ sql, parameters: [] }, 'public');
    expect(query.sql).toBe(`SELECT * FROM (\n${sql}\n) AS q LIMIT $1`);
    expect(query.relationsUsed).toEqual([name]);
  });

  it('publishes exactly the eight catalog projections without storage details or fabricated freshness', async () => {
    expect(views.map((view) => view.name)).toEqual(PUBLIC_RELATION_NAMES);
    const result = await describeCapiroData({}, db(surface));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations.map((relation) => relation.name)).toEqual(PUBLIC_RELATION_NAMES);
    expect(result.relations).toHaveLength(8);
    for (const relation of result.relations) {
      expect(relation).not.toHaveProperty('table');
      expect(relation).not.toHaveProperty('predicate');
      expect(relation.freshness).toMatchObject({ sourceAsOf: null, sourceVersion: null });
      expect(relation.coverage.limitations.join(' ')).toContain('ingestion completeness');
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
    expect(migration).toContain('REVOKE ALL ON ALL TABLES IN SCHEMA meri_public FROM PUBLIC;');
    expect(migration).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA meri_public TO capiro_analytics_ro;');
    expect(views.find((view) => view.name === 'program_elements')?.predicate).toBe('WHERE retired_at IS NULL');
  });

  it.each(additions)('%s is not invented by describe when absent from the current published catalog', async (name) => {
    expect(views.some((view) => view.name === name)).toBe(false);
    expect(await describeCapiroData({ relations: [name] }, db(surface))).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION' } });
  });

  it.each(['committee_hearings', 'committee_hearing_bills', 'legislative_agenda_items', 'state_bill_calendar_events'])
  ('%s does not gain a raw-table fallback from historical projection metadata', async (name) => {
    const sql = `SELECT r.id FROM meri_public_${name} r`;
    const reader = db(surface);
    reader.runPublicSql.mockRejectedValueOnce(translateDatabaseError({ code: '42501', message: `permission denied for table meri_public_${name}` }, null, surface));
    expect(await queryCapiroData({ sql, parameters: [] }, reader)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42501' } });
    expect(reader.runPublicSql).toHaveBeenCalledTimes(1);
    expect(reader.runPublicSql).toHaveBeenCalledWith(expect.objectContaining({ sql: `SELECT * FROM (\n${sql}\n) AS q LIMIT $1` }));
  });

  // These former compiler examples remain explicit: their domains are not in the
  // current catalog, so admission is not evidence of DB access or successful rows.
  it.each<{ label: string; sql: string; parameters: SqlParameter[] }>([
    { label: 'state agenda namespace and optional bill identity', sql: `SELECT h.id AS hearing_id, a.state_bill_key, b.title AS bill_title, h.starts_at, a.source_url
      FROM committee_hearings h INNER JOIN legislative_agenda_items a ON a.hearing_id=h.id
      LEFT JOIN state_bills b ON b.id=a.state_bill_key
      WHERE a.active=$1 AND a.bill_scope=$2 AND h.geographic_jurisdiction=$3`, parameters: [true, 'state', 'FL'] },
    ...[['committee_hearing_bills', 'bill_id'], ['legislative_agenda_items', 'federal_bill_id']].map(([name, key]) => ({
      label: `federal agenda soft reference ${name}`, sql: `SELECT a.${key}, b.title FROM ${name} a LEFT JOIN congress_bills b ON b.id=a.${key}`, parameters: [] })),
    { label: 'distinct state bills after calendar filtering', sql: `WITH matched AS (SELECT DISTINCT b.id FROM state_bills b
      INNER JOIN state_bill_calendar_events e ON e.bill_key=b.id WHERE e.present=$1 AND e.event_type=$2 AND b.session_key=$3)
      SELECT COUNT(*) AS bill_count FROM matched`, parameters: [true, 'hearing', '2097'] },
    { label: 'grant estimates', sql: 'SELECT SUM(g.estimated_funding) AS estimated FROM federal_grants g WHERE g.doc_type=$1', parameters: ['synopsis'] },
    { label: 'SAM identity and separate date bounds', sql: `SELECT s.notice_id, s.source_url FROM sam_opportunities s
      WHERE s.notice_id=$1 AND s.active=$2 AND s.notice_type=$3 AND s.response_deadline>=$4 AND s.archive_date>=$4`,
      parameters: ['synthetic-notice', true, 'Solicitation', '2097-01-01T00:00:00Z'] },
  ])('preserves parameters and owner refusal for $label', async ({ sql, parameters }) => {
    const gated = gateSqlStatement({ sql, parameters }, 'public');
    expect(gated.sql).toBe(`SELECT * FROM (\n${sql}\n) AS q LIMIT $${parameters.length + 1}`);
    expect(gated.params).toEqual([...parameters, 201]);
    const reader = db(surface);
    reader.runPublicSql.mockRejectedValueOnce(translateDatabaseError({ code: '42P01', message: 'relation is not published' }, gated, surface));
    expect(await queryCapiroData({ sql, parameters }, reader)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42P01' } });
    expect(reader.runPublicSql).toHaveBeenCalledWith(gated);
    expect(reader.runPublicSql).toHaveBeenCalledTimes(1);
  });

  it('retains declared soft identity, units and nullable driver output on supported domains', async () => {
    const bills = surface.find((relation) => relation.name === 'congress_bills')!;
    expect(bills.relationships.find((link) => link.referencedRelation === 'congress_members')?.integrity).toBe('soft');
    const budget = surface.find((relation) => relation.name === 'program_element_budget_positions')!;
    expect(budget.fields.find((field) => field.name === 'amount')).toMatchObject({
      type: 'decimal', unit: 'value_kind dependent',
      description: 'total: USD millions; quantity: units; unit_cost: USD millions per unit.',
    });
    expect(budget.coverage.limitations.join(' ')).toContain('Filter value_kind and cycle before summing.');
    const columns: SqlResultColumn[] = [
      { name: 'member_name', type: 'string', pgType: 'text', nullable: true },
      { name: 'last_synced_at', type: 'timestamp', pgType: 'timestamptz', nullable: true },
    ];
    const rows = [{ member_name: null, last_synced_at: '2097-01-01 00:00:00.123456+00' }];
    expect(await queryCapiroData({ sql: 'SELECT m.full_name AS member_name, b.last_synced_at FROM congress_bills b LEFT JOIN congress_members m ON m.bioguide_id=b.sponsor_bioguide_id', parameters: [] }, db(surface, rows, columns)))
      .toMatchObject({ ok: true, columns, rows });
  });

  it.each([
    'SELECT b.raw FROM state_bills b',
    'SELECT h.calendar_provenance FROM committee_hearings h',
    'SELECT a.evidence FROM legislative_agenda_items a',
    'SELECT s.poc_email FROM sam_opportunities s',
    'SELECT g.eligibility FROM federal_grants g',
    'SELECT s.award_amount FROM sam_opportunities s',
    'SELECT f.id FROM federal_awards f',
    'SELECT t.id FROM hearing_follow t',
    'SELECT h.id FROM public.committee_hearing h',
    'SELECT h.id FROM meri_public_committee_hearings h',
  ])('propagates owner denial without retrying a raw relation: %s', async (sql) => {
    const reader = db(surface);
    reader.runPublicSql.mockRejectedValueOnce(translateDatabaseError({ code: '42501', message: 'permission denied for table' }, null, surface));
    expect(await queryCapiroData({ sql, parameters: [] }, reader)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', sqlstate: '42501' } });
    expect(reader.runPublicSql).toHaveBeenCalledTimes(1);
    expect(reader.runPublicSql).toHaveBeenCalledWith(gateSqlStatement({ sql, parameters: [] }, 'public'));
  });

  it.each([
    'SELECT b.id FROM state_bills b INNER JOIN congress_bills c ON c.id=b.id',
    'SELECT a.id FROM legislative_agenda_items a INNER JOIN congress_bills b ON b.id=a.state_bill_key',
    'SELECT b.id FROM state_bills b INNER JOIN state_bills c ON b.identifier=c.identifier',
    'SELECT a.id FROM legislative_agenda_items a INNER JOIN legislative_agenda_items b ON a.item_key=b.item_key',
    'SELECT a.id FROM state_bill_calendar_events a INNER JOIN state_bill_calendar_events b ON a.event_key=b.event_key',
    'SELECT s.notice_id FROM sam_opportunities s INNER JOIN federal_grants g ON s.agency=g.agency',
    'SELECT * FROM federal_grants',
  ])('leaves SQL joins and star projection to PostgreSQL without compiler authorization claims: %s', async (sql) => {
    const gated = gateSqlStatement({ sql, parameters: [] }, 'public');
    expect(gated.sql).toBe(`SELECT * FROM (\n${sql}\n) AS q LIMIT $1`);
    const reader = db(surface);
    reader.runPublicSql.mockRejectedValueOnce(new SqlQueryError('UNKNOWN_RELATION', 'Relation is not published.'));
    expect(await queryCapiroData({ sql, parameters: [] }, reader)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION' } });
    expect(reader.runPublicSql).toHaveBeenCalledWith(gated);
  });

  it.each(['SELECT t.id FROM client_objectives t', 'DELETE FROM state_bills'])
  ('rejects source mixing and writes before execution: %s', async (sql) => {
    const reader = db(surface);
    expect(await queryCapiroData({ sql, parameters: [] }, reader)).toMatchObject({ ok: false });
    expect(reader.runPublicSql).not.toHaveBeenCalled();
  });

  it('keeps source unavailability distinct from empty scoped results and preserves sentinel evidence', async () => {
    const input = { sql: 'SELECT b.id FROM congress_bills b WHERE b.sponsor_state=$1', parameters: ['FL'], rowLimit: 1 };
    const reader = db(surface);
    reader.runPublicSql.mockRejectedValueOnce(new SqlQueryError('SOURCE_UNAVAILABLE', 'Unavailable.'));
    expect(await queryCapiroData(input, reader)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    expect(await queryCapiroData(input, db(surface))).toMatchObject({ ok: true, rowCount: 0, rowLimitReached: false, coverage: { sourceUniverseComplete: false } });
    expect(await queryCapiroData(input, db(surface, [{ id: 'synthetic-1' }, { id: 'synthetic-2' }])))
      .toMatchObject({ ok: true, rowCount: 1, rowLimitReached: true, coverage: { sourceUniverseComplete: false } });
  });
});
