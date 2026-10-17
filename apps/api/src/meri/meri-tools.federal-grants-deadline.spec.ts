import { MeriToolsService } from './meri-tools.service.js';
import { withMeriReadObservation } from './meri-funding-read-observation.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
type SearchFederalGrants = (ctx: { tenantId: string }, input: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeService(rows: Record<string, unknown>[], duringRead: () => void = () => {}) {
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = {
    withSystem: async (fn: (tx: unknown) => unknown) => { duringRead(); return fn({
      federalGrant: { findMany: async () => rows, count: async () => rows.length },
    }); },
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

  test.each(['off', 'shadow', 'enforce'] as const)('uses captured observed %s without replacing the native deadline clock', async mode => {
    Object.assign(process.env, { MERI_EVIDENCE_ACCURACY_MODE: mode, MERI_EVIDENCE_ACCURACY_TENANTS: TENANT, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' });
    const search = makeService([grant({ closeDate: new Date('2026-09-15T00:00:00.000Z') })], () => {
      process.env.MERI_EVIDENCE_ACCURACY_MODE = mode === 'enforce' ? 'off' : 'enforce';
      jest.setSystemTime(new Date('2026-09-11T12:00:00.000Z'));
    });
    const result = await withMeriReadObservation({ operationId: 'search_federal_grants', evidenceAccuracyMode: mode }, () => search({ tenantId: TENANT }, {}));
    expect(result.asOf).toBe('2026-09-11T12:00:00.000Z'); expect(result.generatedAt).toBe(result.asOf);
    const row = (result.data as Array<Record<string, unknown>>)[0]!;
    expect(row.deadlineStatus).toBe('open'); expect(Object.hasOwn(row, 'deadline')).toBe(mode === 'enforce');
    if (mode === 'enforce') expect(row.deadline).toMatchObject({ daysRemaining: 5, dateOnly: '2026-09-15' });
  });

  test('rejects mode drift before grant list/count and leaves the legacy late sample intact', async () => {
    Object.assign(process.env, { MERI_EVIDENCE_ACCURACY_MODE: 'off', MERI_EVIDENCE_ACCURACY_TENANTS: TENANT, MERI_EVIDENCE_ACCURACY_SURFACES: 'chat' });
    const duringRead = jest.fn(() => { process.env.MERI_EVIDENCE_ACCURACY_MODE = 'enforce'; });
    const search = makeService([grant({})], duringRead);
    await expect(withMeriReadObservation({ operationId: 'search_federal_grants', evidenceAccuracyMode: 'enforce' }, () => search({ tenantId: TENANT }, {}))).rejects.toThrow('Current read mode changed');
    expect(duringRead).not.toHaveBeenCalled();
    expect((await search({ tenantId: TENANT }, {})).data).toEqual([expect.objectContaining({ deadline: expect.any(Object) })]);
  });
});
