import { Prisma } from '@prisma/client';
import { AnalyticsDbService, normalizeRow } from './analytics-db.service.js';
import { gateSqlStatement } from './sql-statement-gate.js';

describe('normalizeRow', () => {
  it('flattens BigInt COUNT(*), Decimal SUM/AVG, and Date values to JSON-safe primitives', () => {
    const row = normalizeRow({
      count_all: BigInt(24682),
      sum_amount: new Prisma.Decimal('1234567.89'),
      dt_posted: new Date('2026-08-23T02:34:52.000Z'),
      registrant_name: 'BGR GOVERNMENT AFFAIRS',
      issue_codes: ['DEF', 'BUD'],
      nothing: null,
    });
    expect(row).toEqual({
      count_all: 24682,
      sum_amount: 1234567.89,
      dt_posted: '2026-08-23T02:34:52.000Z',
      registrant_name: 'BGR GOVERNMENT AFFAIRS',
      issue_codes: ['DEF', 'BUD'],
      nothing: null,
    });
    expect(() => JSON.stringify(row)).not.toThrow();
  });

  it('keeps an unsafe-integer BigInt as a string rather than silently losing precision', () => {
    const row = normalizeRow({ big: BigInt('9007199254740993') });
    expect(row.big).toBe('9007199254740993');
  });
});

describe('dedicated public SQL execution', () => {
  const gated = () => gateSqlStatement({ sql: 'SELECT b.congress, b.title FROM congress_bills b WHERE b.id=$1', parameters: ['119-hr-1'] }, 'public');
  const catalogRow = { relation: 'congress_bills', relation_comment: '{"description":"Bills","limitations":["partial"]}', column_name: 'congress', column_type: 'integer', typname: 'int4', column_comment: null };
  function fixture(admission: unknown = { rows: [{ allowed: true }] }) {
    const answers: unknown[] = [
      admission,
      { rows: [catalogRow] },
      { fields: [{ name: 'congress', dataTypeID: 23 }, { name: 'title', dataTypeID: 25 }], rows: [['119', 'Synthetic bill']] },
      { rows: [{ oid: '23', typname: 'int4' }, { oid: '25', typname: 'text' }] },
    ];
    const queries: { text: string; values?: unknown[] }[] = [];
    const client = {
      query: jest.fn(async (input: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
        const text = typeof input === 'string' ? input : input.text;
        queries.push({ text, values: typeof input === 'string' ? values : input.values });
        if (/^(BEGIN|SET LOCAL|COMMIT|ROLLBACK|SELECT pg_catalog.set_config)/.test(text)) return { rows: [], fields: [] };
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      }),
      release: jest.fn(),
    };
    const service = new AnalyticsDbService();
    (service as unknown as { pool: unknown }).pool = { connect: async () => client, end: async () => {} };
    return { service, queries, answers };
  }
  it('starts READ ONLY on meri_public, admits the actual role, reads the surface once, then binds the exact gated SQL', async () => {
    const { service, queries, answers } = fixture();
    const query = gated();
    const result = await service.runPublicSql(query);
    expect(result.rows).toEqual([{ congress: '119', title: 'Synthetic bill' }]);
    expect(result.columns).toEqual([
      { name: 'congress', type: 'integer', pgType: 'int4', nullable: true },
      { name: 'title', type: 'string', pgType: 'text', nullable: true },
    ]);
    expect(result.surface).toEqual([expect.objectContaining({ name: 'congress_bills', description: 'Bills', coverage: { basis: 'ingested_public_records', limitations: ['partial'] } })]);
    expect(queries.map((q) => q.text).slice(0, 6)).toEqual([
      'BEGIN READ ONLY',
      'SET LOCAL search_path = "meri_public"',
      "SET LOCAL statement_timeout = '8000ms'",
      "SET LOCAL lock_timeout = '1000ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '10000ms'",
      "SET LOCAL timezone = 'UTC'",
    ]);
    expect(queries[6]!.values).toEqual(['capiro_analytics_ro', false]);
    expect(queries[7]!.values).toEqual(['meri_public']);
    expect(queries[8]).toEqual({ text: query.sql, values: ['119-hr-1', 201] });
    expect(queries.at(-1)!.text).toBe('COMMIT');
    answers.push({ rows: [{ allowed: true }] });
    expect(await service.describePublic()).toEqual(result.surface);
  });
  it('refuses a bad actual role before data SQL and never commits', async () => {
    const { service, queries } = fixture({ rows: [{ allowed: false }] });
    await expect(service.runPublicSql(gated())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(queries.map((q) => q.text)).not.toContain(expect.stringContaining('FROM congress_bills'));
    expect(queries.map((q) => q.text)).toContain('ROLLBACK');
  });
  it.each([
    ['57014', 'QUERY_TIMEOUT'],
    ['55P03', 'QUERY_TIMEOUT'],
    ['42803', 'INVALID_QUERY'],
    ['42883', 'INVALID_QUERY'],
    ['22P02', 'INVALID_QUERY'],
    ['42703', 'UNKNOWN_FIELD'],
    ['42501', 'UNKNOWN_RELATION'],
    ['42P01', 'UNKNOWN_RELATION'],
    ['53300', 'SOURCE_UNAVAILABLE'],
  ])('translates driver code %s to %s, keeping the PostgreSQL message only for query mistakes', async (code, expected) => {
    const { service, answers } = fixture();
    answers.splice(2, 2, Object.assign(new Error(`pg message for ${code}`), { code, position: '20' }));
    const error = await service.runPublicSql(gated()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: expected, detail: { sqlstate: code } });
    // Relation refusals are restated by translateDatabaseError (the name the model wrote, or none); outages and timeouts are fixed text.
    expect(String((error as Error).message).includes('pg message')).toBe(!['SOURCE_UNAVAILABLE', 'QUERY_TIMEOUT', 'UNKNOWN_RELATION'].includes(expected));
  });
});

describe('AnalyticsDbService', () => {
  const REQUIRED_VARS = ['ANALYTICS_DB_HOST', 'ANALYTICS_DB_PORT', 'ANALYTICS_DB_USER', 'ANALYTICS_DB_PASSWORD', 'ANALYTICS_DB_NAME'];
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of REQUIRED_VARS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of REQUIRED_VARS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('never falls back to DATABASE_URL: refuses to run with no ANALYTICS_DB_* vars set, even if DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgresql://capiro_app:secret@writer-host:5432/capiro';
    const service = new AnalyticsDbService();
    await expect(service.run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' })).rejects.toThrow(/ANALYTICS_DB_HOST/);
    await expect(service.runPublicSql(gateSqlStatement({ sql: 'SELECT 1', parameters: [] }, 'public'))).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    delete process.env.DATABASE_URL;
  });

  it('reports every missing var, not just the first', async () => {
    process.env.ANALYTICS_DB_HOST = 'reader-host';
    const service = new AnalyticsDbService();
    await expect(service.run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' })).rejects.toThrow(
      /ANALYTICS_DB_PORT.*ANALYTICS_DB_USER.*ANALYTICS_DB_PASSWORD.*ANALYTICS_DB_NAME/,
    );
  });

  it('refuses a masked "***" password placeholder and any user other than the reader role', async () => {
    process.env.ANALYTICS_DB_HOST = 'reader-host';
    process.env.ANALYTICS_DB_PORT = '5432';
    process.env.ANALYTICS_DB_USER = 'capiro_analytics_ro';
    process.env.ANALYTICS_DB_PASSWORD = '***';
    process.env.ANALYTICS_DB_NAME = 'capiro';
    await expect(new AnalyticsDbService().run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' })).rejects.toThrow(/masked placeholder/);
    process.env.ANALYTICS_DB_PASSWORD = 'secret';
    process.env.ANALYTICS_DB_USER = 'capiro_app';
    await expect(new AnalyticsDbService().run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' })).rejects.toThrow(/must use capiro_analytics_ro/);
  });
});
