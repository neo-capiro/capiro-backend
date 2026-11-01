import { describeCapiroData, queryCapiroData } from './public-sql-query.js';
import type { PublishedRelation, SqlResultColumn, SqlResultRow } from './sql-reader-connection.js';
import { SqlQueryError } from './sql-statement-gate.js';

const relation = (name: string, fields: string[] = ['id']): PublishedRelation => ({
  name,
  description: `${name} description`,
  grain: 'One row per (id).',
  fields: fields.map((field) => ({ name: field, type: 'string', pgType: 'text', nullable: false, description: field })),
  primaryKey: ['id'],
  relationships: [],
  coverage: { basis: 'ingested_public_records', limitations: [`${name} limitation`] },
  freshness: { field: null, sourceAsOf: null, sourceVersion: null },
});
const surface = [relation('congress_bills', ['id', 'title']), relation('congress_members', ['bioguide_id'])];
const column = (name: string): SqlResultColumn => ({ name, type: 'string', pgType: 'text', nullable: true });
const db = (rows: SqlResultRow[] = [], columns = [column('id')]) => ({
  runPublicSql: jest.fn(async () => ({ columns, rows, surface })),
  describePublic: jest.fn(async () => surface),
});
const input = { sql: 'SELECT b.id FROM congress_bills b', parameters: [], rowLimit: 2 };

describe('public SQL tool envelopes', () => {
  it('publishes the surface the reader role sees, with limits, and narrows to named relations', async () => {
    const result = await describeCapiroData({}, db());
    expect(result).toMatchObject({ version: '0.2.0', ok: true, relations: surface, limits: { maxRowLimit: 1000, maxOutputBytes: 262144 } });
    const narrowed = await describeCapiroData({ relations: ['congress_members'] }, db());
    expect(narrowed.ok && 'relations' in narrowed && narrowed.relations.map((r) => r.name)).toEqual(['congress_members']);
  });
  it('refuses unknown describe fields/relations with candidates and sanitizes reader failures', async () => {
    expect(await describeCapiroData({ tables: ['clients'] }, db())).toMatchObject({ ok: false, error: { code: 'INVALID_QUERY' } });
    expect(await describeCapiroData({ relations: ['congress_bill'] }, db())).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION', candidates: ['congress_bills'] } });
    expect(await describeCapiroData({ relations: ['congress_bills', 'congress_bills'] }, db())).toMatchObject({ ok: false, error: { code: 'UNKNOWN_RELATION' } });
    const failing = db();
    failing.describePublic.mockRejectedValue(new Error('secret connection'));
    expect(await describeCapiroData({}, failing)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'Public data is currently unavailable.' } });
  });
  it('refuses at the gate before the analytics owner is called', async () => {
    const reader = db();
    const result = await queryCapiroData({ ...input, sql: 'DELETE FROM congress_bills' }, reader);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_SQL' } });
    expect(reader.runPublicSql).not.toHaveBeenCalled();
  });
  it('hands the wrapped statement to the owner and reports relations used with their limitations', async () => {
    const reader = db([{ id: '1' }]);
    const result = await queryCapiroData({ sql: 'SELECT b.id FROM congress_bills b JOIN congress_members m ON m.bioguide_id = b.id WHERE b.id = $1', parameters: ['x'] }, reader);
    expect(reader.runPublicSql).toHaveBeenCalledWith(expect.objectContaining({ params: ['x', 201], relationsUsed: ['congress_bills', 'congress_members'] }));
    expect(result).toMatchObject({
      ok: true,
      columns: [column('id')],
      rows: [{ id: '1' }],
      relationsUsed: ['congress_bills', 'congress_members'],
      coverage: {
        basis: 'query_bounded',
        sourceUniverseComplete: false,
        sqlLimit: null,
        relations: [
          { name: 'congress_bills', sourceAsOf: null, sourceVersion: null, limitations: ['congress_bills limitation'] },
          { name: 'congress_members', limitations: ['congress_members limitation'] },
        ],
      },
    });
  });
  it.each([2, 3])('distinguishes exact cap from observed sentinel (%i rows)', async (length) => {
    const result = await queryCapiroData(input, db(Array.from({ length }, (_, i) => ({ id: String(i) }))));
    expect(result).toMatchObject({ ok: true, rowCount: 2, rowLimitReached: length === 3, byteTruncated: false, coverage: { sqlLimit: null }, limits: { rowLimit: 2, maxOutputBytes: 262144 } });
  });
  it('bounds the whole UTF-8 envelope with whole-row truncation independently of the sentinel', async () => {
    const result = await queryCapiroData(input, db([{ id: '字'.repeat(60000) }, { id: '字'.repeat(60000) }, { id: 'sentinel' }]));
    expect(result).toMatchObject({ ok: true, rowCount: 1, rowLimitReached: true, byteTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(262144);
    expect(await queryCapiroData(input, db([{ id: '字'.repeat(100000) }]))).toMatchObject({ ok: false, error: { code: 'OUTPUT_LIMIT' } });
  });
  it('does not turn empty or deliberately limited queries into completeness', async () => {
    const result = await queryCapiroData({ ...input, sql: 'SELECT b.id FROM congress_bills b LIMIT 0' }, db());
    expect(result).toMatchObject({ ok: true, rowCount: 0, rowLimitReached: false, byteTruncated: false, coverage: { sourceUniverseComplete: false, sqlLimit: 0 } });
  });
  it('preserves exact decimal/count strings, booleans and nulls in the envelope', async () => {
    const result = await queryCapiroData({ sql: 'SELECT SUM(b.amount) AS total, COUNT(*) AS n, true AS t, NULL AS x FROM program_element_budget_positions b', parameters: [] },
      db([{ total: '9007199254740993.01', n: '9007199254740993', t: true, x: null }], [column('total'), column('n'), column('t'), column('x')]));
    expect(result).toMatchObject({ ok: true, rows: [{ total: '9007199254740993.01', n: '9007199254740993', t: true, x: null }] });
  });
  it('passes PostgreSQL diagnostics through the refusal envelope and sanitizes unknown errors', async () => {
    const reader = db();
    reader.runPublicSql.mockRejectedValueOnce(new SqlQueryError('UNKNOWN_FIELD', 'column b.titel does not exist', { position: 8, hint: 'Perhaps you meant "b.title".', sqlstate: '42703', candidates: ['title'] }));
    expect(await queryCapiroData(input, reader)).toMatchObject({
      ok: false,
      error: { code: 'UNKNOWN_FIELD', message: 'column b.titel does not exist', position: 8, hint: 'Perhaps you meant "b.title".', sqlstate: '42703', candidates: ['title'] },
    });
    reader.runPublicSql.mockRejectedValueOnce(new Error('secret connection and SQL'));
    expect(await queryCapiroData(input, reader)).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'Public data is currently unavailable.' } });
  });
});
