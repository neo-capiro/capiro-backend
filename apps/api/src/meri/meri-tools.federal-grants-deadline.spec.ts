import { MeriToolsService } from './meri-tools.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
type SearchFederalGrants = (ctx: { tenantId: string }, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeService(rows: Record<string, unknown>[]) {
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => fn({
      federalGrant: { findMany: async () => rows, count: async () => rows.length },
    }),
  };
  return (service as unknown as { searchFederalGrants: SearchFederalGrants }).searchFederalGrants.bind(service);
}

const grant = (over: Record<string, unknown>) => ({
  id: 'grant-1', title: 'Test NOFO', agency: 'DOE', subAgency: null, opportunityNumber: 'DE-1',
  category: null, awardCeiling: null, awardFloor: null, estimatedFunding: null, openDate: null,
  closeDate: null, responseDateDesc: null, status: 'posted', eligibility: [], url: null, ...over,
});

describe('search_federal_grants structured deadlines', () => {
  const originalEnv = process.env;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-10T12:00:00.000Z'));
    process.env = { ...originalEnv };
  });
  afterEach(() => { jest.useRealTimers(); process.env = originalEnv; });

  test.each(['continuous', 'TBD'])('preserves unknown raw deadline text under enforce: %s', async (rawText) => {
    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce', MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    });
    const out = await makeService([grant({ responseDateDesc: rawText })])({ tenantId: TENANT }, {});
    expect((out.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      deadline: { at: null, dateOnly: null, timeZone: null, basis: 'unknown', daysRemaining: null, status: 'unknown', rawText },
    });
  });

  test('keeps off payload legacy and computes real close dates from the response asOf', async () => {
    const closeDate = new Date('2026-09-15T00:00:00.000Z');
    const search = makeService([grant({ closeDate })]);
    const legacy = await search({ tenantId: TENANT }, {});
    expect((legacy.data as Array<Record<string, unknown>>)[0]).not.toHaveProperty('deadline');

    Object.assign(process.env, {
      MERI_EVIDENCE_ACCURACY_MODE: 'enforce', MERI_EVIDENCE_ACCURACY_TENANTS: TENANT,
      MERI_EVIDENCE_ACCURACY_SURFACES: 'chat',
    });
    const enforced = await search({ tenantId: TENANT }, {});
    expect(enforced.asOf).toBe('2026-09-10T12:00:00.000Z');
    expect((enforced.data as Array<Record<string, unknown>>)[0]).toMatchObject({
      deadline: { dateOnly: '2026-09-15', status: 'open', daysRemaining: 6 },
    });
  });
});