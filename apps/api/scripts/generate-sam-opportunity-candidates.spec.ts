import { describe, expect, jest, test } from '@jest/globals';
import {
  CLIENT_CAP,
  DEFAULT_MIN_RELEVANCE,
  OPPORTUNITY_SCAN_CAP,
  decideProducerAction,
  generateSamCandidates,
  parseArgs,
  readPlaceOfPerformance,
  resolveTenantIds,
  type SamCandidatesPrisma,
} from './generate-sam-opportunity-candidates.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const NOTICE = '00000000-0000-0000-0000-0000000003aa';

describe('CLI parsing', () => {
  test('dry run is the default', () => {
    expect(parseArgs([])).toEqual({
      commit: false,
      tenantId: null,
      clientId: null,
      minRelevance: DEFAULT_MIN_RELEVANCE,
    });
  });

  test('--commit, --tenant, --client and --min-relevance are all honoured', () => {
    expect(
      parseArgs(['node', 'x', '--commit', '--tenant', TENANT, '--client', CLIENT, '--min-relevance=40']),
    ).toEqual({ commit: true, tenantId: TENANT, clientId: CLIENT, minRelevance: 40 });
  });

  test('--min-relevance accepts the space form too', () => {
    expect(parseArgs(['node', 'x', '--min-relevance', '30']).minRelevance).toBe(30);
  });
});

describe('decideProducerAction — the human-decision protection', () => {
  const qualifying = { relevanceScore: 50, meetsSuggestionFloor: true, minRelevance: 15 };

  test.each(['saved', 'pursuing', 'dismissed', 'won', 'lost'])(
    'a %s row is left completely alone',
    (status) => {
      const d = decideProducerAction({
        existing: { id: 'wf-1', workflowStatus: status, userCreated: false, evidenceSourceType: 'deterministic_relevance_v1', staleAt: null },
        ...qualifying,
      });
      expect(d.action).toBe('skip_human_decision');
    },
  );

  test('a human-created row is left alone even at status suggested', () => {
    const d = decideProducerAction({
      existing: { id: 'wf-1', workflowStatus: 'suggested', userCreated: true, evidenceSourceType: 'user_action', staleAt: null },
      ...qualifying,
    });
    expect(d.action).toBe('skip_human_decision');
  });

  test('a human decision is preserved even when the score COLLAPSES', () => {
    // A nightly job re-running is not new information about somebody's decision.
    const d = decideProducerAction({
      existing: { id: 'wf-1', workflowStatus: 'pursuing', userCreated: true, evidenceSourceType: 'user_action', staleAt: null },
      relevanceScore: 0,
      meetsSuggestionFloor: false,
      minRelevance: 15,
    });
    expect(d.action).toBe('skip_human_decision');
  });

  test("the producer's OWN suggested row is refreshed when it still qualifies", () => {
    const d = decideProducerAction({
      existing: { id: 'wf-1', workflowStatus: 'suggested', userCreated: false, evidenceSourceType: 'deterministic_relevance_v1', staleAt: null },
      ...qualifying,
    });
    expect(d).toEqual({ action: 'refresh', id: 'wf-1', relevanceScore: 50 });
  });

  test("the producer's own row is marked STALE, never deleted, when it stops qualifying", () => {
    const d = decideProducerAction({
      existing: { id: 'wf-1', workflowStatus: 'suggested', userCreated: false, evidenceSourceType: 'deterministic_relevance_v1', staleAt: null },
      relevanceScore: 2,
      meetsSuggestionFloor: false,
      minRelevance: 15,
    });
    expect(d).toEqual({ action: 'mark_stale', id: 'wf-1' });
  });

  test('an already-stale row is a no-op, so re-runs do not churn updated_at', () => {
    const d = decideProducerAction({
      existing: { id: 'wf-1', workflowStatus: 'suggested', userCreated: false, evidenceSourceType: 'deterministic_relevance_v1', staleAt: new Date() },
      relevanceScore: 2,
      meetsSuggestionFloor: false,
      minRelevance: 15,
    });
    expect(d.action).toBe('noop');
  });

  test('the suggestion FLOOR is required, not just the score', () => {
    // A pile of moderate-only signals can beat minRelevance without amounting to
    // evidence; meetsSuggestionFloor is the real gate.
    const d = decideProducerAction({
      existing: null,
      relevanceScore: 90,
      meetsSuggestionFloor: false,
      minRelevance: 15,
    });
    expect(d.action).toBe('skip_below_floor');
  });

  test('a qualifying new pair is created', () => {
    const d = decideProducerAction({ existing: null, ...qualifying });
    expect(d).toEqual({ action: 'create', relevanceScore: 50 });
  });
});

// ── Fake prisma ─────────────────────────────────────────────────────────────

function noticeRow(partial: Record<string, unknown> = {}) {
  return {
    id: NOTICE,
    title: 'Turbofan Engine Sustainment',
    description: 'Sustainment of turbofan engines.',
    noticeType: 'Solicitation',
    agency: 'Department of the Army',
    subAgency: null,
    office: 'ACC-APG',
    naicsCode: '336411',
    pscCode: '1560',
    setAside: null,
    setAsideCode: null,
    placeOfPerformance: {},
    matches: [] as Array<{ peCode: string | null }>,
    ...partial,
  };
}

function clientRow(partial: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    naicsCodes: ['336411'],
    pscCodes: [],
    applicantTypes: [],
    sectorTag: 'DEFENSE',
    capabilities: [],
    facilities: [],
    ...partial,
  };
}

function makeFake(opts: {
  notices?: Array<Record<string, unknown>>;
  clients?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  flagRows?: Array<{ tenant_id: string }>;
}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const bypassCalls: string[] = [];
  const clientWhere: unknown[] = [];

  const prisma: SamCandidatesPrisma = {
    $transaction: (async (fn: (tx: SamCandidatesPrisma) => Promise<unknown>) => fn(prisma)) as never,
    $executeRawUnsafe: (async (sql: string) => {
      bypassCalls.push(sql);
      return 0;
    }) as never,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('intel_feature_flag')) return (opts.flagRows ?? [{ tenant_id: TENANT }]) as never;
      return [] as never;
    }) as never,
    client: {
      findMany: jest.fn(async (args: unknown) => {
        clientWhere.push((args as { where?: unknown }).where);
        return (opts.clients ?? [clientRow()]) as never;
      }),
    },
    clientIntelMapping: { findMany: jest.fn(async () => [] as never) },
    samOpportunity: {
      findMany: jest.fn(async () => (opts.notices ?? [noticeRow()]) as never),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async () => (opts.existing ?? []) as never),
      create: jest.fn(async (args: unknown) => {
        created.push((args as { data: unknown }).data);
        return {};
      }),
      update: jest.fn(async (args: unknown) => {
        updated.push(args);
        return {};
      }),
    },
  } as unknown as SamCandidatesPrisma;

  return { prisma, created, updated, bypassCalls, clientWhere };
}

describe('generateSamCandidates', () => {
  test('a dry run reports REAL counts and writes nothing', async () => {
    const { prisma, created, updated } = makeFake({});
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.evaluated).toBe(1);
    expect(r.created).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('--commit writes a suggested, producer-owned row', async () => {
    const { prisma, created } = makeFake({});
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.tenantId).toBe(TENANT);
    expect(row.clientId).toBe(CLIENT);
    expect(row.source).toBe('sam_gov');
    expect(row.samOpportunityId).toBe(NOTICE);
    expect(row.grantOpportunityId).toBeNull();
    expect(row.workflowStatus).toBe('suggested');
    expect(row.userCreated).toBe(false);
    expect(row.evidenceSourceType).toBe('deterministic_relevance_v1');
  });

  test('re-running over its own row is idempotent: refresh, not a duplicate', async () => {
    const { prisma, created, updated } = makeFake({
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          samOpportunityId: NOTICE,
          workflowStatus: 'suggested',
          userCreated: false,
          evidenceSourceType: 'deterministic_relevance_v1',
          staleAt: null,
        },
      ],
    });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.created).toBe(0);
    expect(r.refreshed).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(1);
  });

  test('a pursued row is never touched, and is counted as preserved', async () => {
    const { prisma, created, updated } = makeFake({
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          samOpportunityId: NOTICE,
          workflowStatus: 'pursuing',
          userCreated: true,
          evidenceSourceType: 'user_action',
          staleAt: null,
        },
      ],
    });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.humanDecisionsPreserved).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('a non-pursuable notice type is never suggested', async () => {
    const { prisma } = makeFake({ notices: [noticeRow({ noticeType: 'Award Notice' })] });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.evaluated).toBe(0);
    expect(r.created).toBe(0);
  });

  test('every tenant-scoped read carries an EXPLICIT tenantId as well as the bypass', async () => {
    // The bypass only satisfies the RLS predicate. The explicit tenantId is what
    // actually scopes the query; omitting it is a real cross-tenant bug.
    const { prisma, clientWhere, bypassCalls } = makeFake({});
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(bypassCalls.some((s) => s.includes('app.bypass_rls'))).toBe(true);
    expect((clientWhere[0] as { tenantId?: string }).tenantId).toBe(TENANT);
  });

  test('archived and non-active clients are excluded', async () => {
    const { prisma, clientWhere } = makeFake({});
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    const where = clientWhere[0] as Record<string, unknown>;
    expect(where.status).toEqual({ not: 'archived' });
    expect(where.profileStatus).toBe('ACTIVE');
  });

  test('--client narrows the sweep to one client', async () => {
    const { prisma, clientWhere } = makeFake({});
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: CLIENT,
      minRelevance: 15,
      commit: false,
    });
    expect((clientWhere[0] as { id?: string }).id).toBe(CLIENT);
  });

  test('there is no query per (client, notice) pair', async () => {
    const notices = Array.from({ length: 6 }, (_, i) =>
      noticeRow({ id: `00000000-0000-0000-0000-00000000040${i}`, title: `Notice ${i}` }),
    );
    const clients = Array.from({ length: 4 }, (_, i) =>
      clientRow({ id: `00000000-0000-0000-0000-00000000010${i}` }),
    );
    const { prisma } = makeFake({ notices, clients });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    // 24 pairs evaluated, but the notice catalog is read exactly ONCE.
    expect((prisma.samOpportunity.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((prisma.client.findMany as jest.Mock).mock.calls).toHaveLength(1);
    // Award history is one query per client, not per pair.
    expect((prisma.$queryRaw as jest.Mock).mock.calls.length).toBeLessThanOrEqual(clients.length);
  });

  test('a scan that hits its bound reports capped, so partial coverage is not silent', async () => {
    const notices = Array.from({ length: OPPORTUNITY_SCAN_CAP }, (_, i) =>
      noticeRow({ id: `n-${i}`, noticeType: 'Award Notice' }),
    );
    const { prisma } = makeFake({ notices });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.capped).toBe(true);
  });

  test('one failing pair does not abort the rest of the run', async () => {
    const { prisma } = makeFake({
      notices: [noticeRow({ id: 'n-1' }), noticeRow({ id: 'n-2' })],
    });
    let calls = 0;
    (prisma.clientFundingOpportunity.create as jest.Mock).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('unique violation');
      return {};
    });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.errors).toBe(1);
    expect(r.evaluated).toBe(2);
  });

  test('the client cap is a real bound', () => {
    expect(CLIENT_CAP).toBeGreaterThan(0);
    expect(OPPORTUNITY_SCAN_CAP).toBeGreaterThan(0);
  });
});

describe('resolveTenantIds', () => {
  test('--tenant wins outright, regardless of flag state', async () => {
    const { prisma } = makeFake({ flagRows: [] });
    expect(await resolveTenantIds(prisma, TENANT)).toEqual([TENANT]);
  });

  test('otherwise only tenants with an ENABLED funding_opportunities flag', async () => {
    const { prisma } = makeFake({ flagRows: [{ tenant_id: TENANT }] });
    expect(await resolveTenantIds(prisma, null)).toEqual([TENANT]);
  });

  test('no enabled flag means no tenants — there is NO internal-tenant hardcode', async () => {
    // The grant producer mirrors DistrictNexusFlagGuard's implicit internal-tenant
    // fallback. FundingOpportunitiesFlagGuard has no such fallback, so a hardcode
    // here would write rows for a tenant whose read path 404s.
    const { prisma } = makeFake({ flagRows: [] });
    expect(await resolveTenantIds(prisma, null)).toEqual([]);
  });
});

describe('readPlaceOfPerformance', () => {
  test('nested SAM shape, flat shape, and honest null', () => {
    expect(readPlaceOfPerformance({ city: { name: 'El Paso' }, state: { code: 'TX' } })).toEqual({
      city: 'El Paso',
      state: 'TX',
      zip: null,
    });
    expect(readPlaceOfPerformance({ city: 'Dayton', state: 'OH' })).toEqual({
      city: 'Dayton',
      state: 'OH',
      zip: null,
    });
    expect(readPlaceOfPerformance({})).toBeNull();
    expect(readPlaceOfPerformance(null)).toBeNull();
  });
});
