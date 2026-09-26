import { Prisma } from '@prisma/client';
import { AnalyticsDbService, normalizeRow } from './analytics-db.service.js';

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
