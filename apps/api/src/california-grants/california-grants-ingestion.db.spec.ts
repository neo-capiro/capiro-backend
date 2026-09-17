import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { PrismaClient } from '@prisma/client';
import sampleRows from './california-public-sample.fixture.json';
import {
  requireDatabaseUrl,
  syncCaliforniaGrants,
  type CaliforniaGrantRow,
  type CaliforniaGrantPrisma,
} from './california-grants-ingestion.js';
import { lastSuccessfulWatermark, runWithSyncRun } from '../ingestion/sync-run.helper.js';

const testDatabaseUrl = process.env.CALIFORNIA_CATALOG_TEST_DATABASE_URL;
const dbDescribe = testDatabaseUrl === undefined ? describe.skip : describe;
const SAMPLE_ROWS = sampleRows as CaliforniaGrantRow[];
const TEST_SYNC_SOURCE = 'sync-california-grants:california-catalog-01-db';
const TEST_PORTAL_IDS = SAMPLE_ROWS.map((row) => `california-catalog-01-${row.PortalID ?? 'missing'}`);

function requireDedicatedTestDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = requireDatabaseUrl(env);
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.port !== '5486' || url.pathname !== '/fo_v2_ca') {
    throw new Error('CALIFORNIA_CATALOG_TEST_DATABASE_URL must target 127.0.0.1:5486/fo_v2_ca');
  }
  return value;
}

function testRows(): CaliforniaGrantRow[] {
  return SAMPLE_ROWS.map((row) => ({
    ...row,
    PortalID: `california-catalog-01-${row.PortalID}`,
  }));
}

function asCaliforniaPrisma(prisma: PrismaClient): CaliforniaGrantPrisma {
  return prisma as unknown as CaliforniaGrantPrisma;
}

dbDescribe('California catalog real PostgreSQL roundtrip', () => {
  let prisma: PrismaClient | undefined;
  const rows = testRows();

  beforeAll(async () => {
    const url = requireDedicatedTestDatabaseUrl({ DATABASE_URL: testDatabaseUrl });
    prisma = new PrismaClient({ datasources: { db: { url } } });
    await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: { in: TEST_PORTAL_IDS } } });
    await prisma.syncRun.deleteMany({ where: { source: TEST_SYNC_SOURCE } });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.californiaGrantOpportunity.deleteMany({ where: { portalId: { in: TEST_PORTAL_IDS } } });
    await prisma.syncRun.deleteMany({ where: { source: TEST_SYNC_SOURCE } });
    await prisma.$disconnect();
  });

  test('persists exact public rows, records success, and is idempotent', async () => {
    const client = prisma!;
    const fetchPage = async (offset: number, limit: number) => ({
      records: offset === 0 ? rows : [],
      total: 2,
      limit,
      offset,
    });
    const first = await runWithSyncRun(
      client,
      TEST_SYNC_SOURCE,
      () => syncCaliforniaGrants(asCaliforniaPrisma(client), { fetchPage, pageSize: 2 }),
    );
    expect(first).toMatchObject({ inserted: 2, updated: 0, errors: 0, complete: true });
    const watermarkAfterSuccess = await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE);
    expect(watermarkAfterSuccess).not.toBeNull();
    const firstRead = await client.californiaGrantOpportunity.findMany({
      where: { portalId: { in: TEST_PORTAL_IDS } },
      orderBy: { portalId: 'asc' },
    });
    expect(firstRead).toHaveLength(2);
    expect(firstRead.find((row) => row.portalId.endsWith('191235'))?.awardPeriod).toBe('June 31, 2027');
    expect(firstRead.find((row) => row.portalId.endsWith('191346'))?.raw).toEqual(rows[0]);

    const repeat = await runWithSyncRun(
      client,
      TEST_SYNC_SOURCE,
      () => syncCaliforniaGrants(asCaliforniaPrisma(client), { fetchPage, pageSize: 2 }),
    );
    expect(repeat).toMatchObject({ inserted: 0, updated: 2, errors: 0, complete: true });
    expect(await client.californiaGrantOpportunity.count({ where: { portalId: { in: TEST_PORTAL_IDS } } })).toBe(2);
    const successRuns = await client.syncRun.findMany({ where: { source: TEST_SYNC_SOURCE }, orderBy: { startedAt: 'asc' } });
    expect(successRuns.slice(-2).map((run) => run.status)).toEqual(['success', 'success']);
    expect(await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE)).toEqual(successRuns[successRuns.length - 1]!.startedAt);
  });

  test('records partial and success_with_errors without advancing the successful watermark', async () => {
    const client = prisma!;
    const before = await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE);
    expect(before).not.toBeNull();

    const partial = await runWithSyncRun(
      client,
      TEST_SYNC_SOURCE,
      () => syncCaliforniaGrants(asCaliforniaPrisma(client), {
        pageSize: 1,
        maxPages: 1,
        maxRecords: 2,
        fetchPage: async (offset, limit) => ({ records: [rows[0]!], total: 2, limit, offset }),
      }),
    );
    expect(partial.complete).toBe(false);
    const afterPartial = await client.syncRun.findFirst({ where: { source: TEST_SYNC_SOURCE }, orderBy: { startedAt: 'desc' } });
    expect(afterPartial?.status).toBe('partial');
    expect(await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE)).toEqual(before);

    const failingPortalId = TEST_PORTAL_IDS[1]!;
    const failingPrisma: CaliforniaGrantPrisma = {
      californiaGrantOpportunity: {
        findUnique: (args) => client.californiaGrantOpportunity.findUnique(args),
        upsert: async (args) => {
          if (args.where.portalId === failingPortalId) throw new Error('controlled fixture write failure');
          return client.californiaGrantOpportunity.upsert(args as Parameters<typeof client.californiaGrantOpportunity.upsert>[0]);
        },
      },
    };
    const warning = await runWithSyncRun(
      client,
      TEST_SYNC_SOURCE,
      () => syncCaliforniaGrants(failingPrisma, {
        fetchPage: async (offset, limit) => ({ records: rows, total: 2, limit, offset }),
      }),
    );
    expect(warning.errors).toBe(1);
    expect(warning.complete).toBe(true);
    const afterWarning = await client.syncRun.findFirst({ where: { source: TEST_SYNC_SOURCE }, orderBy: { startedAt: 'desc' } });
    expect(afterWarning?.status).toBe('success_with_errors');
    expect(await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE)).toEqual(before);
  });

  test('records error and leaves the successful watermark unchanged', async () => {
    const client = prisma!;
    const before = await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE);
    await expect(runWithSyncRun(
      client,
      TEST_SYNC_SOURCE,
      () => syncCaliforniaGrants(asCaliforniaPrisma(client), {
        fetchPage: async () => { throw new Error('deterministic source failure'); },
      }),
    )).rejects.toThrow('deterministic source failure');
    const failed = await client.syncRun.findFirst({ where: { source: TEST_SYNC_SOURCE }, orderBy: { startedAt: 'desc' } });
    expect(failed?.status).toBe('error');
    expect(failed?.errorMessage).toContain('deterministic source failure');
    expect(await lastSuccessfulWatermark(client, TEST_SYNC_SOURCE)).toEqual(before);
  });
});

test('invalid provided dedicated URL fails before Prisma setup', () => {
  if (testDatabaseUrl === undefined) return;
  expect(() => requireDedicatedTestDatabaseUrl({ DATABASE_URL: 'postgresql://127.0.0.1:5486/not-fo-v2-ca' })).toThrow('must target 127.0.0.1:5486/fo_v2_ca');
  expect(() => requireDedicatedTestDatabaseUrl({ DATABASE_URL: 'postgresql://127.0.0.1:5487/fo_v2_ca' })).toThrow('must target 127.0.0.1:5486/fo_v2_ca');
});
