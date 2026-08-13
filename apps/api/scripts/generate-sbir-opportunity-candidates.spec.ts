import { describe, expect, jest, test } from '@jest/globals';
import {
  DEFAULT_MIN_RELEVANCE,
  PAGE_SIZE,
  generateSbirCandidates,
  parseArgs,
  resolveTenantIds,
  type SbirCandidatesPrisma,
} from './generate-sbir-opportunity-candidates.js';
import { scoreSbirRelevance } from '../src/funding-opportunities/sbir-relevance.js';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const TOPIC = 'sbir-topic-uuid-0001';
const CYCLE_NUMBER = 'DHA243-001';

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
    expect(parseArgs(['node', 'x', '--resume-client', 'client-00042']).resumeClient).toBe(
      'client-00042',
    );
  });

  test('--min-relevance accepts the space form too', () => {
    expect(parseArgs(['node', 'x', '--min-relevance', '30']).minRelevance).toBe(30);
  });
});

describe('the confidence-bridge invariant (scoreSbirRelevance has no numeric score)', () => {
  const base = {
    solicitationStatus: 'Open',
    closeDate: '2099-01-01',
    profileTooThin: false,
    capabilityTopicMatch: false,
    priorAgencyHistory: false,
    historyIsIdentifierBacked: false,
    programElementLinkedSourceBacked: false,
    priorSbirHistorySourceBacked: false,
    asOf: new Date('2026-01-01T12:00:00Z'),
  };

  test.each([
    { programElementLinkedSourceBacked: true },
    { priorSbirHistorySourceBacked: true },
    { priorAgencyHistory: true, historyIsIdentifierBacked: true },
  ])('clearsSuggestionFloor never pairs with low confidence: %j', (signals) => {
    const result = scoreSbirRelevance({ ...base, ...signals });
    expect(result.clearsSuggestionFloor).toBe(true);
    expect(result.recommendationConfidence).not.toBe('low');
  });

  test('name-derived (non-identifier-backed) agency history does NOT clear the floor, and is low confidence', () => {
    const result = scoreSbirRelevance({
      ...base,
      priorAgencyHistory: true,
      historyIsIdentifierBacked: false,
    });
    expect(result.clearsSuggestionFloor).toBe(false);
    expect(result.recommendationConfidence).toBe('low');
  });
});

// ── Fake prisma ─────────────────────────────────────────────────────────────

function topicRow(partial: Record<string, unknown> = {}) {
  return {
    id: TOPIC,
    tangoSbirId: TOPIC,
    title: 'Autonomous sustainment diagnostics',
    agency: 'Defense Health Agency',
    solicitationNumber: CYCLE_NUMBER,
    closeDate: new Date('2099-01-15T00:00:00Z'),
    solicitationStatus: 'Open',
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    lastSyncedAt: new Date('2026-07-01T00:00:00Z'),
    ...partial,
  };
}

function cycleRow(partial: Record<string, unknown> = {}) {
  return {
    solicitationNumber: CYCLE_NUMBER,
    program: 'SBIR',
    cycleName: 'DHA 24.3',
    ...partial,
  };
}

function clientRow(partial: Record<string, unknown> = {}) {
  return {
    id: CLIENT,
    name: 'Acme Diagnostics LLC',
    uei: 'ABC123456789',
    cageCode: null,
    naicsCodes: [],
    pscCodes: [],
    applicantTypes: [],
    setAsideCertifications: [],
    sectorTag: 'HEALTH',
    capabilities: [],
    facilities: [],
    ...partial,
  };
}

function makeFake(opts: {
  topics?: Array<Record<string, unknown>>;
  cycles?: Array<Record<string, unknown>>;
  clients?: Array<Record<string, unknown>>;
  existing?: Array<Record<string, unknown>>;
  flagRows?: Array<{ tenant_id: string }>;
  /** Awarding agencies the fake's federal_award table returns for this client's UEI. */
  contractAgencies?: string[];
}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const bypassCalls: string[] = [];
  const clientWhere: unknown[] = [];
  const cycleQueries: Array<{ in: string[] }> = [];
  const topicPageArgs: Array<{ where?: any; take?: number; orderBy?: unknown }> = [];
  const workflowWhere: any[] = [];

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

  /** Evaluates the `notPastCloseDateWhere` shape (OR of null-or-gte). */
  function matchesWhere(row: Record<string, any>, where: Record<string, any> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === 'id') return true;
      if (key === 'OR') return (cond as unknown[]).some((w) => matchesWhere(row, w as any));
      const value = row[key];
      if (cond === null) return value == null;
      if (cond != null && typeof cond === 'object') {
        if ('gte' in cond) return value != null && new Date(value).getTime() >= new Date((cond as any).gte).getTime();
        if ('in' in cond) return ((cond as any).in as unknown[]).includes(value);
      }
      return value === cond;
    });
  }

  const prisma: SbirCandidatesPrisma = {
    $transaction: (async (fn: (tx: SbirCandidatesPrisma) => Promise<unknown>) => fn(prisma)) as never,
    $executeRawUnsafe: (async (sql: string) => {
      bypassCalls.push(sql);
      return 0;
    }) as never,
    $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (sql.includes('intel_feature_flag')) return (opts.flagRows ?? [{ tenant_id: TENANT }]) as never;
      if (sql.includes('federal_award')) {
        return (opts.contractAgencies ?? []).map((a) => ({
          awarding_agency: a,
          awarding_sub_tier: null,
        })) as never;
      }
      if (sql.includes('federal_assistance_award')) return [] as never;
      return [] as never;
    }) as never,
    client: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number };
        clientWhere.push(a.where);
        return page((opts.clients ?? [clientRow()]) as Array<{ id: string }>, a.where, a.take) as never;
      }),
    },
    clientIntelMapping: { findMany: jest.fn(async () => [] as never) },
    tangoSbirTopic: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: any; take?: number; orderBy?: unknown };
        topicPageArgs.push(a);
        const rows = (opts.topics ?? [topicRow()]) as Array<Record<string, any>>;
        const filtered = rows.filter((r) => matchesWhere(r, a.where));
        return page(filtered as Array<{ id: string }>, a.where, a.take) as never;
      }),
    },
    tangoSbirSolicitation: {
      findMany: jest.fn(async (args: unknown) => {
        const a = args as { where?: { solicitationNumber?: { in: string[] } } };
        const numbers = a.where?.solicitationNumber?.in ?? [];
        cycleQueries.push({ in: numbers });
        const rows = (opts.cycles ?? [cycleRow()]) as Array<{ solicitationNumber: string }>;
        return rows.filter((c) => numbers.includes(c.solicitationNumber)) as never;
      }),
    },
    clientFundingOpportunity: {
      findMany: jest.fn(async (args: unknown) => {
        const where = (args as { where?: any }).where;
        workflowWhere.push(where);
        const rows = (opts.existing ?? []) as Array<Record<string, any>>;
        const keys = where?.sourceRecordKey?.in as string[] | undefined;
        return (keys ? rows.filter((r) => keys.includes(r.sourceRecordKey)) : rows) as never;
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
  } as unknown as SbirCandidatesPrisma;

  return {
    prisma,
    created,
    updated,
    bypassCalls,
    clientWhere,
    cycleQueries,
    topicPageArgs,
    workflowWhere,
  };
}

describe('the topic → cycle join', () => {
  test('program and cycle name are persisted from the CYCLE, not guessed from the topic', async () => {
    const { prisma, created } = makeFake({
      cycles: [cycleRow({ program: 'STTR', cycleName: 'DHA 24.3 STTR' })],
      contractAgencies: ['Defense Health Agency'],
    });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
    const signals = (created[0] as Record<string, unknown>).matchSignals as Record<string, unknown>;
    expect(signals.program).toBe('STTR');
    expect(signals.cycleName).toBe('DHA 24.3 STTR');
  });

  test('an orphan topic — no resolvable cycle — still scores and persists, with null program', async () => {
    const { prisma, created } = makeFake({
      topics: [topicRow({ solicitationNumber: 'no-such-cycle' })],
      cycles: [],
      contractAgencies: ['Defense Health Agency'],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.evaluated).toBe(1);
    expect(created).toHaveLength(1);
    const signals = (created[0] as Record<string, unknown>).matchSignals as Record<string, unknown>;
    expect(signals.program).toBeNull();
  });

  test('the cycle lookup is batched once per topic page, not once per topic', async () => {
    const { prisma, cycleQueries } = makeFake({
      topics: [
        topicRow({ id: 't-1', tangoSbirId: 't-1', solicitationNumber: 'C-1' }),
        topicRow({ id: 't-2', tangoSbirId: 't-2', solicitationNumber: 'C-2' }),
        topicRow({ id: 't-3', tangoSbirId: 't-3', solicitationNumber: 'C-1' }),
      ],
      cycles: [cycleRow({ solicitationNumber: 'C-1' }), cycleRow({ solicitationNumber: 'C-2' })],
    });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(cycleQueries).toHaveLength(1);
    // Deduped: two topics share C-1, so the batch names 2 distinct numbers, not 3.
    expect(cycleQueries[0]!.in.sort()).toEqual(['C-1', 'C-2']);
  });
});

describe('generateSbirCandidates', () => {
  test('a dry run reports REAL counts and writes nothing', async () => {
    const { prisma, created, updated } = makeFake({ contractAgencies: ['Defense Health Agency'] });
    const r = await generateSbirCandidates(prisma, {
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

  test('--commit writes a suggested row with the generic identity and the real eligibility output', async () => {
    const { prisma, created } = makeFake({ contractAgencies: ['Defense Health Agency'] });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
    const row = created[0] as Record<string, unknown>;
    expect(row.tenantId).toBe(TENANT);
    expect(row.clientId).toBe(CLIENT);
    expect(row.source).toBe('sbir_sttr');
    expect(row.sourceRecordType).toBe('sbir_topic');
    expect(row.sourceRecordKey).toBe(TOPIC);
    expect(row.grantOpportunityId).toBeNull();
    expect(row.samOpportunityId).toBeNull();
    expect(row.workflowStatus).toBe('suggested');
    expect(row.evidenceSourceType).toBe('deterministic_relevance_v1');
    // The scorer's real, constant output — never omitted, never invented.
    expect(row.eligibilityState).toBe('needs_review');
    expect(row.eligibilityReason).toEqual(expect.any(String));
  });

  test('a client with no verified identity and no reviewed mapping gets no agency-history signal', async () => {
    // `buildAwardHistoryIdentity`/`readAwardHistoryByBasis` (shared, already
    // exhaustively tested in generate-sam-opportunity-candidates.spec.ts) are
    // reused here unmodified — this test is about THIS producer's own wiring:
    // with no uei and no clientIntelMapping row, the identity basis is 'none',
    // no award-history query is even issued, and the topic correctly gets no
    // agency-history signal rather than a false one.
    const { prisma, created } = makeFake({
      clients: [clientRow({ uei: null })],
      contractAgencies: [],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.created).toBe(0);
    expect(created).toHaveLength(0);
  });

  test('agency names are compared normalized, not verbatim', async () => {
    const { prisma, created } = makeFake({
      topics: [topicRow({ agency: 'Defense Health Agency (DHA)' })],
      contractAgencies: ['DEFENSE HEALTH AGENCY'],
    });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(created).toHaveLength(1);
  });

  test('a topic past its close date is excluded from the corpus entirely', async () => {
    const { prisma } = makeFake({
      topics: [topicRow({ closeDate: new Date('2020-01-01T00:00:00Z') })],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.opportunitiesRead).toBe(0);
    expect(r.evaluated).toBe(0);
  });

  test("a status of 'Closed' excludes the topic even with a future close date", async () => {
    // This is exactly why the status filter runs in JS via isTopicClosed rather
    // than a second SQL predicate: the date alone would have let this through.
    const { prisma } = makeFake({
      topics: [topicRow({ solicitationStatus: 'Closed' })],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.opportunitiesRead).toBe(1); // read by the SQL pre-filter...
    expect(r.pursuableRead).toBe(0); // ...but excluded by the JS status filter
    expect(r.evaluated).toBe(0);
  });

  test("'Closing Soon' is not read as 'Closed' (compared against a set, never a substring)", async () => {
    const { prisma } = makeFake({
      topics: [topicRow({ solicitationStatus: 'Closing Soon' })],
      contractAgencies: ['Defense Health Agency'],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(r.pursuableRead).toBe(1);
    expect(r.evaluated).toBe(1);
  });

  test('re-running over its own row is idempotent: refresh, not a duplicate', async () => {
    const { prisma, created, updated } = makeFake({
      contractAgencies: ['Defense Health Agency'],
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          sourceRecordKey: TOPIC,
          workflowStatus: 'suggested',
          userCreated: false,
          evidenceSourceType: 'deterministic_relevance_v1',
          staleAt: null,
        },
      ],
    });
    const r = await generateSbirCandidates(prisma, {
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
      contractAgencies: ['Defense Health Agency'],
      existing: [
        {
          id: 'wf-1',
          clientId: CLIENT,
          sourceRecordKey: TOPIC,
          workflowStatus: 'pursuing',
          userCreated: true,
          evidenceSourceType: 'user_action',
          staleAt: null,
        },
      ],
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.humanDecisionsPreserved).toBe(1);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  test('every tenant-scoped read carries an EXPLICIT tenantId as well as the bypass', async () => {
    const { prisma, clientWhere, bypassCalls } = makeFake({});
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(bypassCalls.some((s) => s.includes('app.bypass_rls'))).toBe(true);
    expect((clientWhere[0] as { tenantId?: string }).tenantId).toBe(TENANT);
  });

  test('--client narrows the sweep to one client', async () => {
    const { prisma, clientWhere } = makeFake({});
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: CLIENT,
      minRelevance: 15,
      commit: false,
    });
    expect((clientWhere[0] as { id?: string }).id).toBe(CLIENT);
  });

  test('there is no query per (client, topic) pair', async () => {
    const topics = Array.from({ length: 6 }, (_, i) =>
      topicRow({ id: `t-${i}`, tangoSbirId: `t-${i}`, solicitationNumber: CYCLE_NUMBER }),
    );
    const clients = Array.from({ length: 4 }, (_, i) =>
      clientRow({ id: `00000000-0000-0000-0000-00000000010${i}` }),
    );
    const { prisma, cycleQueries } = makeFake({ topics, clients });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect((prisma.tangoSbirTopic.findMany as jest.Mock).mock.calls).toHaveLength(1);
    expect((prisma.client.findMany as jest.Mock).mock.calls).toHaveLength(1);
    // The cycle join is bounded by PAGES, not by (client x topic) pairs.
    expect(cycleQueries).toHaveLength(1);
  });

  test('the workflow read is scoped to the current topic page', async () => {
    const topics = Array.from({ length: PAGE_SIZE + 5 }, (_, i) =>
      topicRow({ id: `t-${String(i).padStart(5, '0')}`, tangoSbirId: `t-${i}` }),
    );
    const { prisma, workflowWhere } = makeFake({ topics });
    await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
    });
    expect(workflowWhere.length).toBeGreaterThan(0);
    for (const where of workflowWhere) {
      expect(where.sourceRecordKey?.in).toBeDefined();
      expect(where.sourceRecordKey.in.length).toBeLessThanOrEqual(PAGE_SIZE);
    }
  }, 60000);

  test('a resumed run starts strictly after the cursor', async () => {
    const clients = Array.from({ length: 5 }, (_, i) => clientRow({ id: `c-${String(i).padStart(5, '0')}` }));
    const { prisma, clientWhere } = makeFake({ clients });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: false,
      resumeClientCursor: `c-${String(1).padStart(5, '0')}`,
    });
    expect((clientWhere[0] as { id?: unknown }).id).toEqual({ gt: `c-${String(1).padStart(5, '0')}` });
    expect(r.clientsRead).toBe(3);
    expect(r.completion).toBe('COMPLETE');
  });

  test('one failing pair does not abort the rest of the run', async () => {
    const { prisma } = makeFake({
      topics: [
        topicRow({ id: 't-1', tangoSbirId: 't-1' }),
        topicRow({ id: 't-2', tangoSbirId: 't-2' }),
      ],
      contractAgencies: ['Defense Health Agency'],
    });
    let calls = 0;
    (prisma.clientFundingOpportunity.create as jest.Mock).mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('unique violation');
      return {};
    });
    const r = await generateSbirCandidates(prisma, {
      tenantIds: [TENANT],
      clientId: null,
      minRelevance: 15,
      commit: true,
    });
    expect(r.errors).toBe(1);
    expect(r.evaluated).toBe(2);
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
    const { prisma } = makeFake({ flagRows: [] });
    expect(await resolveTenantIds(prisma, null)).toEqual([]);
  });
});
