import { Prisma } from '@prisma/client';
import { AnalyticsDbService, normalizeRow, normalizePublicSqlRow } from './analytics-db.service.js';
import { compilePublicSql } from './sql-query-compiler.js';

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
  const compiled = () => compilePublicSql({ sql: 'SELECT b.congress, b.title FROM congress_bills b WHERE b.id=$1', parameters: ['119-hr-1'] });
  function fixture(role = true, grant = true) {
    const tx = { $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRawUnsafe: jest.fn().mockResolvedValueOnce([{ allowed: role }]).mockResolvedValueOnce([{ allowed: grant }])
        .mockResolvedValue([{ congress: '119', title: 'Synthetic bill' }]) };
    const transaction = jest.fn((run: (connection: typeof tx) => unknown) => run(tx));
    const service = new AnalyticsDbService();
    (service as unknown as { client: unknown }).client = { $transaction: transaction };
    return { service, tx, transaction };
  }
  it('starts READ ONLY before any query, verifies actual role/grant, then binds exact compiler SQL', async () => {
    const { service, tx, transaction } = fixture(), query = compiled();
    expect(await service.runPublicSql(query)).toEqual([{ congress: '119', title: 'Synthetic bill' }]);
    expect(tx.$executeRawUnsafe.mock.calls.map(([sql]) => sql)).toEqual([
      'SET TRANSACTION READ ONLY', 'SET LOCAL search_path = pg_catalog', "SET LOCAL statement_timeout = '8000ms'",
      "SET LOCAL lock_timeout = '1000ms'", "SET LOCAL idle_in_transaction_session_timeout = '10000ms'", "SET LOCAL timezone = 'UTC'",
    ]);
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRawUnsafe.mock.invocationCallOrder[0]!);
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain("current_user = 'capiro_analytics_ro' AND session_user = 'capiro_analytics_ro'");
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain('pg_catalog.pg_auth_members');
    expect(tx.$queryRawUnsafe.mock.calls[0][0]).toContain("pg_catalog.has_any_column_privilege(current_user, c.oid, 'INSERT,UPDATE,REFERENCES')");
    expect(tx.$queryRawUnsafe.mock.calls[1][1]).toBe('public.congress_bill');
    expect(tx.$queryRawUnsafe).toHaveBeenLastCalledWith(query.sql, '119-hr-1');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { timeout: 10000, maxWait: 2000 });
  });
  it.each([[false, true, 1], [true, false, 2]])('refuses bad actual role or unavailable grant before data SQL', async (role, grant, calls) => {
    const { service, tx } = fixture(Boolean(role), Boolean(grant));
    await expect(service.runPublicSql(compiled())).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(tx.$queryRawUnsafe).toHaveBeenCalledTimes(Number(calls));
  });
  it.each([
    ['57014', 'QUERY_TIMEOUT'], ['55P03', 'QUERY_TIMEOUT'], ['42803', 'INVALID_QUERY'], ['42883', 'INVALID_QUERY'],
    ['22P02', 'INVALID_QUERY'], ['22007', 'INVALID_QUERY'], ['22008', 'INVALID_QUERY'],
    ['42501', 'SOURCE_UNAVAILABLE'], ['42P01', 'SOURCE_UNAVAILABLE'],
  ])('classifies fixed driver code %s without disclosing driver details', async (code, expected) => {
    const { service, tx } = fixture();
    tx.$queryRawUnsafe.mockRejectedValue({ code: 'P2010', meta: { code, message: 'private SQL and connection information' } });
    await expect(service.runPublicSql(compiled())).rejects.toMatchObject({ code: expected });
    await expect(service.runPublicSql(compiled())).rejects.not.toThrow(/private/);
  });
  it('keeps exact numeric strings, dates, booleans and nulls and refuses lossy driver numbers', () => {
    const columns = [
      { name: 'amount', type: 'decimal' as const, nullable: true }, { name: 'n', type: 'integer' as const, nullable: false },
      { name: 'date', type: 'date' as const, nullable: false }, { name: 'flag', type: 'boolean' as const, nullable: false },
    ];
    expect(normalizePublicSqlRow({ amount: '9007199254740993.01', n: '9007199254740993', date: new Date('2026-01-01T00:00:00Z'), flag: true }, columns))
      .toEqual({ amount: '9007199254740993.01', n: '9007199254740993', date: '2026-01-01', flag: true });
    expect(normalizePublicSqlRow({ amount: null, n: '0', date: new Date('2026-01-01T00:00:00Z'), flag: false }, columns).amount).toBeNull();
    expect(() => normalizePublicSqlRow({ amount: 100.1, n: '0', date: new Date(), flag: true }, columns)).toThrow();
  });
});

describe('AnalyticsDbService', () => {
  const REQUIRED_VARS = [
    'ANALYTICS_DB_HOST',
    'ANALYTICS_DB_PORT',
    'ANALYTICS_DB_USER',
    'ANALYTICS_DB_PASSWORD',
    'ANALYTICS_DB_NAME',
  ];
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
    await expect(
      service.run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' }),
    ).rejects.toThrow(/ANALYTICS_DB_HOST/);
    delete process.env.DATABASE_URL;
  });

  it('reports every missing var, not just the first', async () => {
    process.env.ANALYTICS_DB_HOST = 'reader-host';
    const service = new AnalyticsDbService();
    await expect(
      service.run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' }),
    ).rejects.toThrow(/ANALYTICS_DB_PORT.*ANALYTICS_DB_USER.*ANALYTICS_DB_PASSWORD.*ANALYTICS_DB_NAME/);
  });

  it('refuses to build a connection from a masked "***" password placeholder', async () => {
    process.env.ANALYTICS_DB_HOST = 'reader-host';
    process.env.ANALYTICS_DB_PORT = '5432';
    process.env.ANALYTICS_DB_USER = 'capiro_analytics_ro';
    process.env.ANALYTICS_DB_PASSWORD = '***';
    process.env.ANALYTICS_DB_NAME = 'capiro';
    const service = new AnalyticsDbService();
    await expect(
      service.run({ sql: 'SELECT 1', params: [], datasetKey: 'lda_registrations' }),
    ).rejects.toThrow(/masked placeholder/);
  });
});
