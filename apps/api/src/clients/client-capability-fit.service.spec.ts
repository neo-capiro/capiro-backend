import { describe, expect, jest, test } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { ClientCapabilityFitService } from './client-capability-fit.service.js';
import { capabilityFitFingerprint } from './client-capability-fit.fingerprint.js';
import type { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import type { TrackerService } from '../tracker/tracker.service.js';
import type { RecommendationBill, RecommendationsResponse } from '../tracker/tracker.types.js';
import type { FundingOpportunitiesService } from '../funding-opportunities/funding-opportunities.service.js';
import type { FundingOpportunityListResponse } from '../funding-opportunities/funding-opportunities.types.js';
import type { FoCapabilityFitInput } from './client-capability-fit.normalize.js';

/**
 * "Where capabilities create fit" (client Portfolio → Capabilities tab).
 *
 * The card is a PROJECTION of scores that already exist upstream, so these tests
 * pin the projection contract rather than any scoring maths:
 *
 *  1. A wrong-tenant / archived client is a 404 before any scorer runs.
 *  2. Zero capabilities → `profile_too_thin`, and the slow PE fan-out is never
 *     called (nothing could match).
 *  3. Only capability-grounded PE rows reach the card — facility/award/ecosystem
 *     relevance is real, but it is not "capabilities created this fit".
 *  4. A GET never pays for the ~30s PE fan-out: cache hit serves cache, cache
 *     miss returns an honest not-computed empty.
 *  5. Refresh always recomputes and upserts the cache.
 *  6. A cache computed against different capability signals reads back `stale`.
 *  7. Phase B: tracker bills join PE rows; tracker failure degrades, not blanks.
 *  8. Phase C: FO rows join with 0..100 scale preserved; FO failure degrades.
 */
describe('ClientCapabilityFitService', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as any;
  const clientId = 'client-1';

  const CAP_ROBOTICS = {
    id: 'cap-1',
    name: 'Autonomous Ground Systems',
    tags: ['autonomy', 'robotics'],
    keywords: ['UGV'],
    peNumbers: ['0605053A'],
    peNumber: null,
    sector: 'defense',
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
  };

  function billRec(overrides: Partial<RecommendationBill> = {}): RecommendationBill {
    return {
      billId: '119-hr-9201',
      displayNum: 'H.R. 9201',
      title: 'Defense Autonomy Test Range Act',
      stage: 'introduced',
      probability: 0.4,
      fit: 0.94,
      belowFloor: false,
      matchedTags: ['autonomy', 'robotics'],
      matchReasons: [],
      whyKind: 'keyword',
      why: 'Matched capability tags: autonomy, robotics',
      latestAction: null,
      latestActionDate: null,
      sponsorName: null,
      sponsorParty: null,
      cosponsorsCount: 0,
      ...overrides,
    };
  }

  function foRow(overrides: Partial<FoCapabilityFitInput> = {}): FoCapabilityFitInput {
    return {
      id: 'sam_gov:abc-123',
      source: 'sam_gov',
      sourceRecordId: 'abc-123',
      title: 'UGV Autonomy R&D',
      relevanceScore: 88,
      matchedSignals: [
        { signal: 'naicsExact', strength: 'strong', weight: 30, matchedOn: '541330' },
      ],
      eligibility: { state: 'eligible', reason: 'No disqualifying eligibility signals.' },
      _meetsFloor: true,
      ...overrides,
    };
  }

  function emptyFoList(): FundingOpportunityListResponse {
    return {
      opportunities: [],
      total: 0,
      totalIsCapped: false,
      page: 1,
      pageSize: 50,
      counts: {
        activeGrants: 0,
        activeContracts: 0,
        saved: 0,
        pursuing: 0,
        dismissed: 0,
        deadlinesIn30Days: 0,
      },
      freshness: [],
      emptyReason: null,
      emptyExplanation: null,
      missingProfileFields: [],
      generatedAt: '2026-08-21T12:00:00.000Z',
    } as unknown as FundingOpportunityListResponse;
  }

  function makeService(opts: {
    client?: { id: string } | null;
    capabilities?: any[];
    cached?: any;
    pes?: Array<{ peCode: string; title: string | null; score: number; paths: any[] }>;
    bills?: RecommendationsResponse | Error;
    fos?: FundingOpportunityListResponse | Error | FoCapabilityFitInput[];
  }) {
    const tx = {
      client: {
        findFirst: jest
          .fn<() => Promise<{ id: string } | null>>()
          .mockResolvedValue(opts.client === undefined ? { id: clientId } : opts.client),
      },
      clientCapability: {
        findMany: jest.fn<() => Promise<any[]>>().mockResolvedValue(opts.capabilities ?? []),
      },
      clientCapabilityFitRecommendation: {
        findUnique: jest.fn<() => Promise<any>>().mockResolvedValue(opts.cached ?? null),
        upsert: jest.fn(async (args: any) => ({
          matches: args.create?.matches ?? args.update?.matches ?? [],
          inputFingerprint:
            args.create?.inputFingerprint ?? args.update?.inputFingerprint ?? null,
          computedAt: new Date('2026-08-21T12:00:00.000Z'),
        })),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, fn: (tx: any) => Promise<any>) => fn(tx)),
    };
    const peRelevance = {
      getRelevantPesForClient: jest.fn<() => Promise<any>>().mockResolvedValue({
        data: opts.pes ?? [],
        total: (opts.pes ?? []).length,
        page: 1,
        limit: 50,
      }),
    } as unknown as ClientPeRelevanceService;

    const billPayload: RecommendationsResponse =
      opts.bills instanceof Error
        ? { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.45 }
        : (opts.bills ?? { recommendations: [], aboveFloorCount: 0, total: 0, floor: 0.45 });

    const trackerGet = jest.fn<() => Promise<RecommendationsResponse>>();
    if (opts.bills instanceof Error) {
      trackerGet.mockRejectedValue(opts.bills);
    } else {
      trackerGet.mockResolvedValue(billPayload);
    }
    const tracker = {
      getRecommendations: trackerGet,
    } as unknown as TrackerService;

    let foPayload: FundingOpportunityListResponse;
    if (opts.fos instanceof Error) {
      foPayload = emptyFoList();
    } else if (Array.isArray(opts.fos)) {
      foPayload = { ...emptyFoList(), opportunities: opts.fos as any, total: opts.fos.length };
    } else {
      foPayload = opts.fos ?? emptyFoList();
    }

    const foList = jest.fn<() => Promise<FundingOpportunityListResponse>>();
    if (opts.fos instanceof Error) {
      foList.mockRejectedValue(opts.fos);
    } else {
      foList.mockResolvedValue(foPayload);
    }
    const fundingOpportunities = {
      listClientOpportunities: foList,
    } as unknown as FundingOpportunitiesService;

    const service = new ClientCapabilityFitService(
      prisma as any,
      peRelevance,
      tracker,
      fundingOpportunities,
    );
    return { service, prisma, tx, peRelevance, tracker, fundingOpportunities };
  }

  test('throws NotFound for a client outside the tenant before scoring anything', async () => {
    const { service, peRelevance } = makeService({ client: null });
    await expect(service.getFit(ctx, clientId)).rejects.toBeInstanceOf(NotFoundException);
    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
  });

  test('reports profile_too_thin without running PE or tracker when there are no capabilities', async () => {
    const { service, peRelevance, tracker, tx } = makeService({ capabilities: [] });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(result.status).toBe('profile_too_thin');
    expect(result.matches).toEqual([]);
    expect(result.emptyReason).toMatch(/capability/i);
    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
    expect(tracker.getRecommendations).not.toHaveBeenCalled();
    // Persisted anyway, so the UI shows the thin state instead of spinning.
    expect(tx.clientCapabilityFitRecommendation.upsert).toHaveBeenCalledTimes(1);
  });

  test('keeps only capability-grounded PE rows on the card', async () => {
    const { service } = makeService({
      capabilities: [CAP_ROBOTICS],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 1,
          paths: [
            { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
        {
          peCode: '0604256F',
          title: 'Hypersonics',
          score: 0.82,
          paths: [
            {
              path: 'capability_keyword',
              score: 0.82,
              evidence: ['Keyword match: hypersonics', 'similarity 0.82'],
            },
          ],
        },
        {
          peCode: '0601101E',
          title: 'Defense Research',
          score: 0.6,
          paths: [
            { path: 'facility_district', score: 0.6, evidence: ['Facility in district(s): TX-37'] },
          ],
        },
      ],
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(result.status).toBe('ready');
    expect(result.matches.map((m: { targetId: string }) => m.targetId)).toEqual([
      '0605053A',
      '0604256F',
    ]);
    expect(result.matches[0]).toMatchObject({ fit: 100, why: 'Capability lists PE 0605053A' });
    expect(result.matches[1]).toMatchObject({ fit: 82, why: 'Keyword match: hypersonics' });
    // PE+bill+FO all attempted; empty FO list still counts fo=true when the call succeeded.
    expect(result.sources).toEqual({ pe: true, bill: true, fo: true });
  });

  test('attributes a direct PE row to the capability that names it', async () => {
    const { service } = makeService({
      capabilities: [CAP_ROBOTICS, { ...CAP_ROBOTICS, id: 'cap-2', peNumbers: ['0604256F'] }],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 1,
          paths: [
            { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(result.matches[0]?.capabilityIds).toEqual(['cap-1']);
  });

  test('a GET with a cache hit serves the cache and never runs the PE fan-out', async () => {
    const { service, peRelevance, tracker, fundingOpportunities } = makeService({
      capabilities: [CAP_ROBOTICS],
      cached: {
        matches: [{ id: 'pe:0605053A', kind: 'pe', targetId: '0605053A', fit: 100 }],
        // Fingerprint of exactly these capabilities, so the cache is fresh.
        inputFingerprint: capabilityFitFingerprint({ capabilities: [CAP_ROBOTICS] }),
        computedAt: new Date('2026-08-20T10:00:00.000Z'),
      },
    });

    const result = await service.getFit(ctx, clientId);

    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
    expect(tracker.getRecommendations).not.toHaveBeenCalled();
    expect(fundingOpportunities.listClientOpportunities).not.toHaveBeenCalled();
    expect(result.matches).toHaveLength(1);
    expect(result.computedAt).toBe('2026-08-20T10:00:00.000Z');
    expect(result.sources).toEqual({ pe: true, bill: true, fo: true });
  });

  test('a GET with a cache miss returns an honest not-computed empty, not a slow compute', async () => {
    const { service, peRelevance, tracker, fundingOpportunities, tx } = makeService({
      capabilities: [CAP_ROBOTICS],
      cached: null,
    });

    const result = await service.getFit(ctx, clientId);

    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
    expect(tracker.getRecommendations).not.toHaveBeenCalled();
    expect(fundingOpportunities.listClientOpportunities).not.toHaveBeenCalled();
    expect(tx.clientCapabilityFitRecommendation.upsert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ matches: [], computedAt: null, status: 'empty' });
    expect(result.emptyReason).toMatch(/not computed/i);
  });

  test('flags a cache computed against different capability signals as stale', async () => {
    const { service, peRelevance, tracker, fundingOpportunities } = makeService({
      capabilities: [CAP_ROBOTICS],
      cached: {
        matches: [{ id: 'pe:0605053A', kind: 'pe', targetId: '0605053A', fit: 100 }],
        inputFingerprint: 'a-fingerprint-from-older-capability-signals',
        computedAt: new Date('2026-08-20T10:00:00.000Z'),
      },
    });

    const result = await service.getFit(ctx, clientId);

    expect(result.status).toBe('stale');
    // Still serves the cached rows — stale beats blank while the user decides.
    expect(result.matches).toHaveLength(1);
    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
    expect(tracker.getRecommendations).not.toHaveBeenCalled();
    expect(fundingOpportunities.listClientOpportunities).not.toHaveBeenCalled();
  });

  test('a refresh recomputes and upserts the cache with a fingerprint', async () => {
    const { service, peRelevance, tracker, fundingOpportunities, tx } = makeService({
      capabilities: [CAP_ROBOTICS],
      cached: {
        matches: [],
        inputFingerprint: 'old',
        computedAt: new Date('2026-08-20T10:00:00.000Z'),
      },
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 1,
          paths: [
            { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(peRelevance.getRelevantPesForClient).toHaveBeenCalledTimes(1);
    expect(tracker.getRecommendations).toHaveBeenCalledWith(clientId, ctx.tenantId);
    expect(fundingOpportunities.listClientOpportunities).toHaveBeenCalledWith(
      ctx.tenantId,
      clientId,
      expect.objectContaining({ activeState: 'active', page: 1, pageSize: 50 }),
    );
    expect(tx.clientCapabilityFitRecommendation.upsert).toHaveBeenCalledTimes(1);
    const upsertArgs = (tx.clientCapabilityFitRecommendation.upsert as any).mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ clientId });
    expect(upsertArgs.create.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.status).toBe('ready');
    expect(result.computedAt).toBe('2026-08-21T12:00:00.000Z');
  });

  test('reports empty (not thin) when capabilities exist but nothing cleared the floor', async () => {
    const { service } = makeService({ capabilities: [CAP_ROBOTICS], pes: [] });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(result.status).toBe('empty');
    expect(result.matches).toEqual([]);
    expect(result.emptyReason).toMatch(/no /i);
  });

  test('merges PE and bill rows sorted by fit, with tracker fit 0.94 → card fit 94', async () => {
    const { service, tracker } = makeService({
      capabilities: [CAP_ROBOTICS],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 0.8,
          paths: [
            { path: 'capability_pe_direct', score: 0.8, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
      bills: {
        recommendations: [
          billRec({ fit: 0.94, belowFloor: false }),
          billRec({
            billId: '119-s-12',
            displayNum: 'S. 12',
            title: 'Low Fit Bill',
            fit: 0.2,
            belowFloor: true,
            why: 'weak',
          }),
        ],
        aboveFloorCount: 1,
        total: 2,
        floor: 0.45,
      },
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(tracker.getRecommendations).toHaveBeenCalledWith(clientId, ctx.tenantId);
    expect(result.sources).toEqual({ pe: true, bill: true, fo: true });
    // Bill 94 ranks above PE 80; below-floor bill dropped by billToMatch.
    expect(result.matches.map((m: { id: string; fit: number }) => ({ id: m.id, fit: m.fit }))).toEqual(
      [
        { id: 'bill:119-hr-9201', fit: 94 },
        { id: 'pe:0605053A', fit: 80 },
      ],
    );
    expect(result.matches[0]).toMatchObject({
      kind: 'bill',
      target: 'H.R. 9201 · Defense Autonomy Test Range Act',
      why: 'Matched capability tags: autonomy, robotics',
      score01: 0.94,
      href: '/bills/119-hr-9201',
    });
  });

  test('a tracker failure leaves PE rows intact and flips sources.bill off', async () => {
    const { service, tracker } = makeService({
      capabilities: [CAP_ROBOTICS],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 1,
          paths: [
            { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
      bills: new Error('tracker unavailable'),
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(tracker.getRecommendations).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ready');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe('pe');
    expect(result.sources).toEqual({ pe: true, bill: false, fo: true });
  });

  test('merges FO rows with relevanceScore 88 → fit 88 (never 8800) and drops below-floor', async () => {
    const { service, fundingOpportunities } = makeService({
      capabilities: [CAP_ROBOTICS],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 0.7,
          paths: [
            { path: 'capability_pe_direct', score: 0.7, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
      fos: [
        foRow({ relevanceScore: 88, _meetsFloor: true }),
        foRow({
          source: 'grants_gov',
          sourceRecordId: 'GRANT-9',
          id: 'grants_gov:GRANT-9',
          title: 'Weak FO',
          relevanceScore: 12,
          _meetsFloor: false,
        }),
      ],
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(fundingOpportunities.listClientOpportunities).toHaveBeenCalledWith(
      ctx.tenantId,
      clientId,
      expect.objectContaining({ activeState: 'active' }),
    );
    expect(result.sources).toEqual({ pe: true, bill: true, fo: true });
    // FO 88 > PE 70; below-floor FO dropped.
    expect(result.matches.map((m: { id: string; fit: number }) => ({ id: m.id, fit: m.fit }))).toEqual(
      [
        { id: 'fo:sam_gov:abc-123', fit: 88 },
        { id: 'pe:0605053A', fit: 70 },
      ],
    );
    expect(result.matches[0]).toMatchObject({
      kind: 'fo',
      score01: 0.88,
      target: 'UGV Autonomy R&D',
      href: '/intelligence/opportunities/sam_gov/abc-123',
      why: 'The notice and the client are both classified under NAICS 541330.',
    });
  });

  test('an FO failure leaves PE/bill rows intact and flips sources.fo off', async () => {
    const { service, fundingOpportunities } = makeService({
      capabilities: [CAP_ROBOTICS],
      pes: [
        {
          peCode: '0605053A',
          title: 'Ground Robotics',
          score: 1,
          paths: [
            { path: 'capability_pe_direct', score: 1, evidence: ['Capability lists PE 0605053A'] },
          ],
        },
      ],
      bills: {
        recommendations: [billRec({ fit: 0.5 })],
        aboveFloorCount: 1,
        total: 1,
        floor: 0.45,
      },
      fos: new Error('fo unavailable'),
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(fundingOpportunities.listClientOpportunities).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ready');
    expect(result.matches.some((m: { kind: string }) => m.kind === 'fo')).toBe(false);
    expect(result.matches.some((m: { kind: string }) => m.kind === 'pe')).toBe(true);
    expect(result.matches.some((m: { kind: string }) => m.kind === 'bill')).toBe(true);
    expect(result.sources).toEqual({ pe: true, bill: true, fo: false });
  });

  test('profile_too_thin short-circuits before PE, tracker, and FO fan-out', async () => {
    const { service, peRelevance, tracker, fundingOpportunities, tx } = makeService({
      capabilities: [],
    });

    const result = await service.getFit(ctx, clientId, { refresh: true });

    expect(result.status).toBe('profile_too_thin');
    expect(peRelevance.getRelevantPesForClient).not.toHaveBeenCalled();
    expect(tracker.getRecommendations).not.toHaveBeenCalled();
    expect(fundingOpportunities.listClientOpportunities).not.toHaveBeenCalled();
    expect(tx.clientCapabilityFitRecommendation.upsert).toHaveBeenCalledTimes(1);
  });
});
