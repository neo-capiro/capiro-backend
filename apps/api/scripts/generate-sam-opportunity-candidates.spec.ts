import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MIN_RELEVANCE,
  PAGE_SIZE,
  generateSamCandidates,
  parseArgs,
  readPlaceOfPerformance,
  resolveTenantIds,
  type SamCandidatesPrisma,
} from './generate-sam-opportunity-candidates.js';
import { decideProducerAction } from '../src/funding-opportunities/producer-decision.js';

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
      resumeClient: null,
    });
  });

  test('--commit, --tenant, --client and --min-relevance are all honoured', () => {
    expect(
      parseArgs(['node', 'x', '--commit', '--tenant', TENANT, '--client', CLIENT, '--min-relevance=40']),
    ).toEqual({
      commit: true,
      tenantId: TENANT,
      clientId: CLIENT,
      minRelevance: 40,
      resumeClient: null,
    });
    // P04 resume flag, spelled the same as the grant producer's.
    expect(parseArgs(['node', 'x', '--resume-client', 'client-00042']).resumeClient).toBe(
      'client-00042',
    );
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
    active: true,
    responseDeadline: new Date('2027-01-15T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    lastSyncedAt: new Date('2026-07-01T00:00:00Z'),
    matches: [] as Array<{ peCode: string | null }>,
    ...partial,
  };
}

/**
 * Shaped to CLIENT_PROFILE_SELECT, the one select all three profile callers share
 * since P01. `uei` in particular: this producer never selected it before, which is
 * exactly why contract award history differed from the read path.
 */
function clientRow(partial: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    name: 'Acme Defense LLC',
    uei: 'ABC123456789',
    cageCode: null,
    naicsCodes: ['336411'],
    pscCodes: [],
    applicantTypes: [],
    setAsideCertifications: [],
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
  contractHistory?: Array<{ awarding_agency: string | null; awarding_sub_tier: string | null }>;
}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const bypassCalls: string[] = [];
  const clientWhere: unknown[] = [];
  const awardHistoryQueries: Array<{ sql: string; values: unknown[] }> = [];
  const noticePageArgs: Array<{ where?: any; take?: number; orderBy?: unknown }> = [];
  const workflowWhere: any[] = [];

  // Keyset-aware paging. The producer walks with `id > cursor ORDER BY id`, so a
  // fake that ignored the cursor and returned the whole array every call would
  // never terminate — and the boundary and resume tests below would be testing
  // nothing.
  function page<T extends { id: string }>(
    rows: T[],
    where: Record<string, any> | undefined,
    take: number | undefined,
  ): T[] {
    const gt = (where?.id as { gt?: string } | undefined)?.gt;
    const exact = typeof where?.id === 'string' ? (where.id as string) : null;
    let out = [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (exact) out = out.filter((r) => r.id === exact);
    if (gt) out = out.filter((r) => r.id > gt);
    return take == null ? out : out.slice(0, take);
  }

  const prisma: SamCandidatesPrisma = {
    $transaction: (async (fn: (tx: SamCandidatesPrisma) => Promise<unknown>) => fn(prisma)) as never,
    $executeRawUnsafe: (async (sql: string) => {
      bypassCalls.push(sql);
      return 0;
    }) as never,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('intel_feature_flag')) return (opts.flagRows ?? [{ tenant_id: TENANT }]) as never;
      if (sql.includes('federal_award')) {
        awardHistoryQueries.push({ sql, values });
        return (opts.contractHistory ?? []) as never;
      }
      return [] as never;
    }) as never,
    client: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number };
        clientWhere.push(a.where);
        return page(
          (opts.clients ?? [clientRow()]) as Array<{ id: string }>,
          a.where,
          a.take,
        ) as never;
      }),
    },
    clientIntelMapping: { findMany: jest.fn(async () => [] as never) },
    samOpportunity: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number; orderBy?: unknown };
        noticePageArgs.push(a);
        return page(
          (opts.notices ?? [noticeRow()]) as Array<{ id: string }>,
          a.where,
          a.take,
        ) as never;
      }),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async (args: unknown) => {
        const where = (args as { where?: any }).where;
        workflowWhere.push(where);
        const rows = (opts.existing ?? []) as Array<Record<string, any>>;
        const ids = where?.samOpportunityId?.in as string[] | undefined;
        // The producer scopes this read to the current notice page. Honouring
        // that here is what proves the scoping is real rather than cosmetic.
        return (ids
          ? rows.filter((r) => ids.includes(r.samOpportunityId))
          : rows) as never;
      }),
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

  return {
    prisma,
    created,
    updated,
    bypassCalls,
    clientWhere,
    awardHistoryQueries,
    noticePageArgs,
    workflowWhere,
  };
}

describe('award-history identity matches the read path (P01)', () => {
  test("the client's OWN uei is queried, not only its reviewed mappings", async () => {
    // The bug P01 fixes. This producer built contract identities from confirmed
    // `contracting` mapping UEIs only and never selected `Client.uei`, while the
    // HTTP read path used both. A client holding its own UEI with no confirmed
    // contracting mapping therefore had prior-agency history on screen that this
    // job could not reproduce, so it would decline to suggest a notice the page
    // scored highly. Nothing caught it because no test built both profiles.
    const { prisma, awardHistoryQueries } = makeFake({ clients: [clientRow()] });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(awardHistoryQueries).toHaveLength(1);
    const [ueis] = awardHistoryQueries[0]!.values as [string[], string[]];
    expect(ueis).toContain('ABC123456789');
  });

  test('a client with no uei and no mappings queries no award history at all', async () => {
    // Not "queries with an empty array": an unbounded scan of federal_award with
    // no identity predicate is the failure this guard exists to prevent.
    const { prisma, awardHistoryQueries } = makeFake({
      clients: [clientRow({ uei: null })],
    });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(awardHistoryQueries).toHaveLength(0);
  });

  test('a malformed uei is not treated as an identifier', async () => {
    const { prisma, awardHistoryQueries } = makeFake({
      clients: [clientRow({ uei: 'not-a-uei' })],
    });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(awardHistoryQueries).toHaveLength(0);
  });

  test('award history is read ONCE per client, never once per notice', async () => {
    const { prisma, awardHistoryQueries } = makeFake({
      notices: [noticeRow({ id: 'n-1' }), noticeRow({ id: 'n-2' }), noticeRow({ id: 'n-3' })],
    });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(awardHistoryQueries).toHaveLength(1);
  });
});

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

    // Award history is bounded by CLIENTS, and specifically by two bounded reads
    // per client — one per award rail. P01 made this producer build the whole
    // versioned profile rather than only its SAM half, so it now reads assistance
    // history too. That is the deliberate cost of the read path and both
    // producers being byte-comparable; it is still O(clients), which is what this
    // test is about.
    const historyCalls = (prisma.$queryRaw as jest.Mock).mock.calls.filter(([strings]) =>
      Array.from(strings as TemplateStringsArray)
        .join('?')
        .includes('federal_a'),
    );
    expect(historyCalls.length).toBeLessThanOrEqual(2 * clients.length);

    // The invariant the bound above is only a proxy for: doubling the notice
    // count must not change the query count at all. A magic number drifts; this
    // does not.
    const doubled = makeFake({
      notices: [
        ...notices,
        ...notices.map((n, i) => ({ ...n, id: `00000000-0000-0000-0000-00000000050${i}` })),
      ],
      clients,
    });
    await generateSamCandidates(doubled.prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    const doubledHistoryCalls = (doubled.prisma.$queryRaw as jest.Mock).mock.calls.filter(
      ([strings]) =>
        Array.from(strings as TemplateStringsArray)
          .join('?')
          .includes('federal_a'),
    );
    expect(doubledHistoryCalls.length).toBe(historyCalls.length);
  });

  test('a corpus of only non-pursuable notices is COMPLETE with nothing evaluated', async () => {
    // Award notices are excluded from the scored set ENTIRELY, not down-ranked, so
    // a corpus of them is fully covered and evaluates zero pairs. Before P04 this
    // shape reported `capped`, which conflated "we read everything and none of it
    // was pursuable" with "we ran out of budget".
    const notices = Array.from({ length: 1200 }, (_, i) =>
      noticeRow({ id: `n-${pad(i)}`, noticeType: 'Award Notice' }),
    );
    const r = await generateSamCandidates(makeFake({ notices }).prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.completion).toBe('COMPLETE');
    expect(r.opportunitiesRead).toBe(1200);
    expect(r.pursuableRead).toBe(0);
    expect(r.evaluated).toBe(0);
    expect(r.errors).toBe(0);
  }, 60000);

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

  test('the page size is a page size, not a coverage bound', () => {
    // Replaces "the client cap is a real bound". PAGE_SIZE only limits how many
    // rows are held in memory at once; the walk continues past it. Asserting it is
    // positive still matters — a zero page size would loop forever, which is why
    // walkKeyset rejects it outright.
    expect(PAGE_SIZE).toBeGreaterThan(0);
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

// ── P04: complete coverage ──────────────────────────────────────────────────

/** Zero-padded so lexicographic id order matches numeric order. */
const pad = (n: number) => String(n).padStart(5, '0');

describe('coverage is complete, not capped', () => {
  test('4,001 notices and 501 clients: the LAST row of each is evaluated', async () => {
    // One past each old bound (4,000 notices / 500 clients). Before P04 the
    // 4,001st notice and the 501st client were never read.
    const notices = Array.from({ length: 4001 }, (_, i) => noticeRow({ id: `n-${pad(i)}` }));
    const clients = Array.from({ length: 501 }, (_, i) => clientRow({ id: `c-${pad(i)}` }));
    const r = await generateSamCandidates(makeFake({ notices, clients }).prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.completion).toBe('COMPLETE');
    expect(r.clientsRead).toBe(501);
    expect(r.opportunitiesRead).toBe(4001);
    expect(r.pursuableRead).toBe(4001);
    expect(r.evaluated).toBe(4001 * 501);
    expect(r.complete).not.toBe(false);
    expect(r.errors).toBe(0);
    expect(r.resumeClientCursor).toBeNull();
  }, 180000);

  test('a page-sized corpus is COMPLETE, not mistaken for a full page with more behind it', async () => {
    const notices = Array.from({ length: PAGE_SIZE }, (_, i) => noticeRow({ id: `n-${pad(i)}` }));
    const r = await generateSamCandidates(makeFake({ notices }).prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.completion).toBe('COMPLETE');
    expect(r.opportunitiesRead).toBe(PAGE_SIZE);
  }, 60000);

  test('the notice walk pages by keyset, never by response deadline', async () => {
    // responseDeadline is nullable, non-unique and mutable. Paging on it can show a
    // row twice or never — which is why the pre-P04 read ordered by it and could
    // only ever be a capped snapshot of the most urgent slice, not a walk.
    const notices = Array.from({ length: PAGE_SIZE + 10 }, (_, i) =>
      noticeRow({ id: `n-${pad(i)}` }),
    );
    const { prisma, noticePageArgs } = makeFake({ notices });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(noticePageArgs.length).toBeGreaterThan(1);
    for (const args of noticePageArgs) {
      expect(args.orderBy).toEqual({ id: 'asc' });
      expect(JSON.stringify(args.orderBy)).not.toContain('responseDeadline');
      expect(args.take).toBe(PAGE_SIZE);
    }
    expect(noticePageArgs[1]!.where.id).toEqual({ gt: `n-${pad(PAGE_SIZE - 1)}` });
  }, 60000);

  test('informational notices never enter the scored set, at any page boundary', async () => {
    // Interleaved so award notices land in the middle of pages as well as at the
    // edges: a filter applied per page must not depend on where in the corpus a
    // non-pursuable notice happens to sit.
    const notices = Array.from({ length: PAGE_SIZE + 20 }, (_, i) =>
      noticeRow({
        id: `n-${pad(i)}`,
        noticeType: i % 2 === 0 ? 'Award Notice' : 'Solicitation',
      }),
    );
    const total = PAGE_SIZE + 20;
    const expectedPursuable = Math.floor(total / 2);
    const r = await generateSamCandidates(makeFake({ notices }).prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.completion).toBe('COMPLETE');
    expect(r.opportunitiesRead).toBe(total);
    expect(r.pursuableRead).toBe(expectedPursuable);
    expect(r.evaluated).toBe(expectedPursuable);
  }, 60000);

  test('a resumed run starts strictly AFTER the cursor', async () => {
    const clients = Array.from({ length: 5 }, (_, i) => clientRow({ id: `c-${pad(i)}` }));
    const { prisma, clientWhere } = makeFake({ clients });
    const r = await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
      resumeClientCursor: `c-${pad(1)}`,
    });
    expect((clientWhere[0] as { id?: unknown }).id).toEqual({ gt: `c-${pad(1)}` });
    expect(r.clientsRead).toBe(3);
    expect(r.completion).toBe('COMPLETE');
  });

  test('the workflow read is scoped to the current notice page', async () => {
    const notices = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => noticeRow({ id: `n-${pad(i)}` }));
    const { prisma, workflowWhere } = makeFake({ notices });
    await generateSamCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(workflowWhere.length).toBeGreaterThan(0);
    for (const where of workflowWhere) {
      // Unscoped, this read grows with a client's entire suggestion history rather
      // than with the page being processed.
      expect(where.samOpportunityId?.in).toBeDefined();
      expect(where.samOpportunityId.in.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
  }, 60000);

  test('the completion vocabulary is the SAME as the grant producer', async () => {
    // P04 requires it explicitly: two producers reporting partial coverage in
    // different words is how an operator misses one of them.
    const r = await generateSamCandidates(makeFake({}).prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(['COMPLETE', 'INCOMPLETE']).toContain(r.completion);
    expect(r).toHaveProperty('clientsRead');
    expect(r).toHaveProperty('opportunitiesRead');
    expect(r).toHaveProperty('resumeClientCursor');
  });

  test('no output tells an operator to raise a cap', () => {
    // Comments stripped first: the file legitimately EXPLAINS the caps it replaced.
    const source = readFileSync(join(__dirname, 'generate-sam-opportunity-candidates.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n\r]*/g, '');
    expect(source).not.toMatch(/raise (the )?(audited )?caps?/i);
    expect(source).not.toMatch(/\bCAPPED\b/);
    expect(source).not.toMatch(/OPPORTUNITY_SCAN_CAP|CLIENT_CAP/);
    // The env overrides existed only to raise the cap. With no cap they are dead.
    expect(source).not.toMatch(/SAM_OPPORTUNITY_SCAN_CAP|SAM_CANDIDATE_CLIENT_CAP/);
  });
});
