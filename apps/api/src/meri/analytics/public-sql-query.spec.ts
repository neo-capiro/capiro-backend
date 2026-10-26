import { describeCapiroData, queryCapiroData } from './public-sql-query.js';
import { PublicSqlError } from './sql-query-compiler.js';

describe('public SQL tool envelopes', () => {
  const input = { sql: 'SELECT b.id FROM congress_bills b', parameters: [], rowLimit: 2 };
  it('publishes logical metadata without physical relations or false freshness', () => {
    const result = describeCapiroData({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected metadata');
    expect(result.relations).toHaveLength(8);
    for (const relation of result.relations) {
      expect(relation).not.toHaveProperty('table'); expect(relation).not.toHaveProperty('predicate');
      for (const field of relation.fields) expect(field).not.toHaveProperty('parameterType');
      expect(relation.freshness.sourceAsOf).toBeNull(); expect(relation.freshness.sourceVersion).toBeNull();
    }
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
  });
  it('refuses unknown describe fields/relations', () => {
    expect(describeCapiroData({ tables: ['clients'] }).ok).toBe(false);
    expect(describeCapiroData({ relations: ['clients'] }).ok).toBe(false);
  });
  it('rejects invalid SQL before the analytics owner is called', async () => {
    const db = { runPublicSql: jest.fn() };
    const result = await queryCapiroData({ ...input, sql: 'DELETE FROM congress_bills' }, db);
    expect(result.ok).toBe(false); expect(db.runPublicSql).not.toHaveBeenCalled();
  });
  it.each([2, 3])('distinguishes exact cap from observed sentinel (%i rows)', async (length) => {
    const db = { runPublicSql: jest.fn().mockResolvedValue(Array.from({ length }, (_, i) => ({ id: String(i) }))) };
    const result = await queryCapiroData(input, db);
    expect(result).toMatchObject({ ok: true, rowCount: 2, rowLimitReached: length === 3, byteTruncated: false,
      coverage: { basis: 'query_bounded', sourceUniverseComplete: false, sqlLimit: null }, limits: { rowLimit: 2, maxOutputBytes: 262144 } });
  });
  it('bounds the whole UTF-8 envelope with whole-row truncation independently of the sentinel', async () => {
    const db = { runPublicSql: jest.fn().mockResolvedValue([{ id: '字'.repeat(60000) }, { id: '字'.repeat(60000) }, { id: 'sentinel' }]) };
    const result = await queryCapiroData(input, db);
    expect(result).toMatchObject({ ok: true, rowCount: 1, rowLimitReached: true, byteTruncated: true });
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(262144);
  });
  it('does not turn empty or deliberately limited queries into completeness', async () => {
    const result = await queryCapiroData({ ...input, sql: 'SELECT b.id FROM congress_bills b LIMIT 0' }, { runPublicSql: jest.fn().mockResolvedValue([]) });
    expect(result).toMatchObject({ ok: true, rowCount: 0, rowLimitReached: false, byteTruncated: false,
      coverage: { sourceUniverseComplete: false, sqlLimit: 0 } });
  });
  it('packs a large multibyte multirow result in one pass within the full envelope cap', async () => {
    const result = await queryCapiroData({ ...input, rowLimit: 1000 },
      { runPublicSql: jest.fn().mockResolvedValue(Array.from({ length: 1001 }, (_, i) => ({ id: `${i}${'字'.repeat(4000)}` }))) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected bounded success');
    expect(result.byteTruncated).toBe(true); expect(result.rowLimitReached).toBe(true);
    expect(result.rowCount).toBe(result.rows.length); expect(result.rowCount).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(262144);
  });
  it('preserves exact decimal/count strings and nulls in the envelope', async () => {
    const result = await queryCapiroData({ sql: 'SELECT SUM(b.amount) AS total, COUNT(*) AS n FROM program_element_budget_positions b', parameters: [] },
      { runPublicSql: jest.fn().mockResolvedValue([{ total: '9007199254740993.01', n: '9007199254740993' }]) });
    expect(result).toMatchObject({ ok: true, rows: [{ total: '9007199254740993.01', n: '9007199254740993' }] });
  });
  it('sanitizes unknown errors and preserves stable timeout errors', async () => {
    expect(await queryCapiroData(input, { runPublicSql: jest.fn().mockRejectedValue(new Error('secret connection and SQL')) }))
      .toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'Public data is currently unavailable.' } });
    expect(await queryCapiroData(input, { runPublicSql: jest.fn().mockRejectedValue(new PublicSqlError('QUERY_TIMEOUT', 'Narrow the query.')) }))
      .toMatchObject({ ok: false, error: { code: 'QUERY_TIMEOUT', message: 'Narrow the query.' } });
  });
});
