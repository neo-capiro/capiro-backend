import { describe, expect, jest, test } from '@jest/globals';
import type { PrismaClient } from '@prisma/client';
import {
  generateForecastCandidates,
  parseArgs,
  resolveTenantIds,
  PAGE_SIZE,
} from './generate-forecast-opportunity-candidates.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
function forecast(extra: Record<string, unknown> = {}) {
  return {
    id: 'F1',
    tangoForecastId: 'T1',
    title: 'Autonomous navigation',
    description: null,
    agency: 'Navy',
    departmentName: null,
    organizationAgencyName: null,
    naicsCode: '541715',
    pscCode: null,
    placeOfPerformance: null,
    anticipatedAwardDate: new Date('2026-09-10'),
    estimatedPeriod: 'Q4 FY26',
    fiscalYear: 2026,
    isActive: true,
    status: 'Planned',
    providerModifiedAt: null,
    ...extra,
  };
}
function client(extra: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    name: 'Autonomy Labs',
    uei: null,
    cageCode: null,
    naicsCodes: ['541715'],
    pscCodes: [],
    applicantTypes: [],
    setAsideCertifications: [],
    sectorTag: null,
    capabilities: [],
    facilities: [],
    ...extra,
  };
}
function fake(
  options: {
    forecasts?: any[];
    clients?: any[];
    existing?: any[];
    enabled?: boolean;
    racedDecision?: boolean;
    createError?: object;
  } = {},
) {
  const rows = [...(options.existing ?? [])];
  const created: any[] = [],
    updated: any[] = [],
    reads: any[] = [],
    querySql: any[] = [];
  const db: any = {};
  const paginate = (input: any[], args: any) =>
    input
      .filter((row) => !args.where?.id?.gt || row.id > args.where.id.gt)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, args.take);
  db.$transaction = async (fn: any) => fn(db);
  db.$executeRawUnsafe = jest.fn(async () => 0);
  db.$queryRaw = jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    querySql.push({ sql, values });
    if (sql.includes('intel_feature_flag'))
      return options.enabled === false ? [] : [{ tenant_id: TENANT }];
    return [];
  });
  db.client = {
    findMany: jest.fn(async (args: any) => {
      reads.push(args);
      return paginate(
        (options.clients ?? [client()]).filter(
          (row) => typeof args.where.id !== 'string' || row.id === args.where.id,
        ),
        args,
      );
    }),
  };
  db.clientIntelMapping = { findMany: jest.fn(async () => []) };
  db.tangoProcurementForecast = {
    findMany: jest.fn(async (args: any) => paginate(options.forecasts ?? [forecast()], args)),
  };
  db.clientFundingOpportunity = {
    findMany: jest.fn(async (args: any) =>
      rows.filter(
        (row) =>
          args.where.clientId.in.includes(row.clientId) &&
          args.where.sourceRecordKey.in.includes(row.sourceRecordKey),
      ),
    ),
    create: jest.fn(async ({ data }: any) => {
      if (options.createError) throw options.createError;
      created.push(data);
      rows.push({ id: `wf-${rows.length}`, humanDecision: null, ...data });
      return data;
    }),
    updateMany: jest.fn(async (args: any) => {
      updated.push(args);
      if (options.racedDecision) return { count: 0 };
      const row = rows.find((r) => r.id === args.where.id);
      if (row) Object.assign(row, args.data);
      return { count: row ? 1 : 0 };
    }),
  };
  return { db: db as PrismaClient, created, updated, reads, querySql };
}
const opts = {
  tenantId: TENANT,
  clientId: null,
  minRelevance: 15,
  commit: true,
};
const existing = (extra: Record<string, unknown> = {}) => ({
  id: 'wf1',
  clientId: CLIENT,
  sourceRecordKey: 'T1',
  workflowStatus: 'suggested',
  humanDecision: null,
  userCreated: false,
  evidenceSourceType: 'deterministic_relevance_v1',
  staleAt: null,
  ...extra,
});

describe('forecast candidate producer', () => {
  test('dry-run default, explicit scope and validated relevance floor', () => {
    expect(parseArgs([])).toEqual({
      tenantId: null,
      clientId: null,
      commit: false,
      minRelevance: 15,
    });
    expect(parseArgs(['--commit', '--tenant', TENANT, '--client=' + CLIENT])).toMatchObject({
      ...opts,
      clientId: CLIENT,
    });
    expect(() => parseArgs(['--min-relevance=nan'])).toThrow();
    expect(() => parseArgs(['--min-relevance=-1'])).toThrow();
  });
  test('explicit tenant cannot bypass master or forecast capability flags', async () => {
    const f = fake({ enabled: false });
    expect(await resolveTenantIds(f.db, TENANT)).toEqual([]);
    expect(f.querySql[0].sql).toContain('JOIN intel_feature_flag forecast');
    const result = await generateForecastCandidates(f.db, opts);
    expect(result.evaluated).toBe(0);
    expect(f.reads).toHaveLength(0);
    expect(f.created).toHaveLength(0);
  });
  test('exact code match creates one durable client forecast with no deadline, task or eligibility claim', async () => {
    const f = fake();
    const result = await generateForecastCandidates(f.db, opts);
    expect(result.created).toBe(1);
    expect(f.created[0]).toMatchObject({
      tenantId: TENANT,
      clientId: CLIENT,
      source: 'agency_forecast',
      sourceRecordType: 'tango_procurement_forecast',
      sourceRecordKey: 'T1',
      workflowStatus: 'suggested',
      responseDeadlineSnapshot: null,
      eligibilityState: null,
      matchSignals: expect.arrayContaining([
        { signal: 'exact_naics_match', matchedOn: '541715' },
        expect.objectContaining({ forecastRecommendation: 'shape_now' }),
      ]),
    });
    expect(f.created[0]).not.toHaveProperty('nextActionDueAt');
    expect(f.created[0]).not.toHaveProperty('taskId');
    expect(f.reads[0].where).toMatchObject({
      tenantId: TENANT,
      profileStatus: 'ACTIVE',
      status: { not: 'archived' },
    });
    await generateForecastCandidates(f.db, opts);
    expect(f.created).toHaveLength(1);
    expect(f.updated).toHaveLength(1);
  });
  test('dry run evaluates matches without any writes', async () => {
    const f = fake();
    const result = await generateForecastCandidates(f.db, {
      ...opts,
      commit: false,
    });
    expect(result.created).toBe(1);
    expect(f.created).toHaveLength(0);
    expect(f.updated).toHaveLength(0);
  });
  test('location-only, generic capability, thin profile and inactive forecasts cannot manufacture suggestions', async () => {
    for (const c of [
      client({
        naicsCodes: [],
        applicantTypes: ['Small businesses'],
        facilities: [{ state: 'VA' }],
      }),
      client({
        naicsCodes: [],
        capabilities: [{ name: 'Services', keywords: [], peNumbers: [], tags: [] }],
      }),
      client({ naicsCodes: [] }),
    ]) {
      const f = fake({
        clients: [c],
        forecasts: [
          forecast({
            naicsCode: null,
            title: 'Services in VA',
            placeOfPerformance: 'VA',
          }),
        ],
      });
      expect((await generateForecastCandidates(f.db, opts)).created).toBe(0);
    }
    expect(
      (
        await generateForecastCandidates(
          fake({ forecasts: [forecast({ isActive: false })] }).db,
          opts,
        )
      ).created,
    ).toBe(0);
  });
  test.each(['saved', 'pursuing', 'dismissed', 'won', 'lost'])(
    'preserves %s human work',
    async (status) => {
      const f = fake({ existing: [existing({ workflowStatus: status })] });
      expect((await generateForecastCandidates(f.db, opts)).humanDecisionsPreserved).toBe(1);
      expect(f.updated).toHaveLength(0);
    },
  );
  test('preserves an older monitor decision still marked suggested', async () => {
    const f = fake({ existing: [existing({ humanDecision: 'monitor' })] });
    expect((await generateForecastCandidates(f.db, opts)).humanDecisionsPreserved).toBe(1);
    expect(f.updated).toHaveLength(0);
  });
  test('conditional write preserves a decision made during scoring', async () => {
    const f = fake({ existing: [existing()], racedDecision: true });
    expect((await generateForecastCandidates(f.db, opts)).humanDecisionsPreserved).toBe(1);
    expect(f.updated[0].where).toMatchObject({
      tenantId: TENANT,
      clientId: CLIENT,
      humanDecision: null,
      userCreated: false,
      workflowStatus: { in: ['suggested', 'expired'] },
    });
    expect(f.updated[0].data).not.toHaveProperty('sourceFingerprint');
  });
  test('rescoring marks only machine suggestions stale; concurrent creates are harmless', async () => {
    const f = fake({
      existing: [existing()],
      forecasts: [forecast({ isActive: false })],
    });
    expect((await generateForecastCandidates(f.db, opts)).markedStale).toBe(1);
    const raced = await generateForecastCandidates(
      fake({ createError: { code: 'P2002' } }).db,
      opts,
    );
    expect(raced.errors).toBe(0);
    expect(raced.created).toBe(0);
    expect(raced.skipped).toBe(1);
  });
  test('walks beyond one page and scopes an explicit client', async () => {
    const f = fake({
      clients: [client(), client({ id: 'other' })],
      forecasts: Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
        forecast({
          id: `F${String(i).padStart(5, '0')}`,
          tangoForecastId: `T${i}`,
        }),
      ),
    });
    const result = await generateForecastCandidates(f.db, {
      ...opts,
      clientId: CLIENT,
      commit: false,
    });
    expect(result.clientsRead).toBe(1);
    expect(result.evaluated).toBe(PAGE_SIZE + 1);
    expect(result.completion).toBe('COMPLETE');
  });
});
