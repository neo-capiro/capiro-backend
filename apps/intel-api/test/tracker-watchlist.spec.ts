import {
  HEARING_TERMS_TOPIC_LABEL,
  TrackerWatchlistService,
} from '../src/tracker/tracker-watchlist.service.js';

/**
 * P5/P6 (plan §5.2) — the unified tracker watchlist service.
 *
 *  - P6 sector-default: a never-configured client (no `wl:` row) surfaces the
 *    sector-derived issue area as a read-time SUGGESTION (no write on read).
 *  - P5 flat-term preservation: putWatchlist's delete+rebuild only touches the
 *    `wl:<clientId>` row's topics + its own topicId-NULL terms — hearing FLAT
 *    terms on OTHER watchlist rows (random cuid, old WatchlistsTab) are never
 *    touched.
 *  - P5 flat-term migration: flat terms ON the `wl:` row fold into a synthetic
 *    "Hearing terms" topic on read (rather than being dropped).
 *
 * Pure-unit with a hand-rolled prisma double (no DB); parallels rls.spec /
 * seed-suggestions.spec conventions.
 */

const TENANT = 'tenant-1';
const CLIENT = '11111111-1111-1111-1111-111111111111';
const WL_ID = `wl:${CLIENT}`;

// getWatchlist reads run inside withTenant (RLS); getSectorSuggestion uses
// withSystem. These shims run the callback with the supplied tx bag (the real
// withTenant opens a SET-LOCAL tx). Prevents the pre-existing "withTenant is not
// a function" red that predates LegiWatch B (service adopted withTenant in G3).
function tenantReader(tx: Record<string, unknown>, sectorTag?: string): unknown {
  return {
    withTenant: async (_tid: string, fn: (t: unknown) => unknown) => fn(tx),
    withSystem: async (fn: (t: unknown) => unknown) =>
      fn({ $queryRawUnsafe: async () => (sectorTag ? [{ sectorTag }] : []) }),
  };
}

describe('TrackerWatchlistService.getWatchlist — P6 sector-default', () => {
  it('returns the sector-derived issue area as a suggestion when no watchlist row exists', async () => {
    const prisma = tenantReader({ watchlist: { findFirst: async () => null } }, 'DEFENSE') as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getWatchlist(TENANT, CLIENT);

    expect(view.issueAreas).toEqual([]);
    expect(view.topics).toEqual([]);
    expect(view.suggestedIssueAreas).toEqual(['Defense']);
  });

  it('omits the suggestion when the sector maps to no issue area', async () => {
    const prisma = tenantReader({ watchlist: { findFirst: async () => null } }, 'OTHER') as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getWatchlist(TENANT, CLIENT);
    expect(view.suggestedIssueAreas).toBeUndefined();
  });

  it('never carries a suggestion once a watchlist row exists (parity-safe)', async () => {
    const prisma = tenantReader({
      watchlist: { findFirst: async () => ({ issueAreas: ['Energy'] }) },
      watchlistTopic: { findMany: async () => [] },
      watchlistTerm: { findMany: async () => [] },
    }) as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getWatchlist(TENANT, CLIENT);
    expect(view.issueAreas).toEqual(['Energy']);
    expect(view.suggestedIssueAreas).toBeUndefined();
  });
});

describe('TrackerWatchlistService.getWatchlist — P5 flat-term folding', () => {
  it('folds topicId-NULL terms on the wl: row into a synthetic "Hearing terms" topic', async () => {
    const prisma = tenantReader({
      watchlist: { findFirst: async () => ({ issueAreas: [] }) },
      watchlistTopic: {
        findMany: async () => [
          {
            id: 'top-1',
            label: 'data center load',
            issueArea: 'Energy',
            position: 'monitor',
            priority: 'high',
          },
        ],
      },
      watchlistTerm: {
        findMany: async () => [
          { topicId: 'top-1', termType: 'synonym', value: 'large-load' },
          { topicId: null, termType: 'topic', value: 'interconnection queue' },
          { topicId: null, termType: 'agency', value: 'FERC' },
        ],
      },
    }) as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getWatchlist(TENANT, CLIENT);

    expect(view.topics).toHaveLength(2);
    const real = view.topics.find((t) => t.label === 'data center load');
    expect(real?.terms).toEqual([{ termType: 'synonym', value: 'large-load' }]);
    const synthetic = view.topics.find((t) => t.label === HEARING_TERMS_TOPIC_LABEL);
    expect(synthetic?.terms).toEqual([
      { termType: 'topic', value: 'interconnection queue' },
      { termType: 'agency', value: 'FERC' },
    ]);
  });

  it('does not add a synthetic topic when there are no flat terms', async () => {
    const prisma = tenantReader({
      watchlist: { findFirst: async () => ({ issueAreas: [] }) },
      watchlistTopic: {
        findMany: async () => [
          { id: 'top-1', label: 'tag', issueArea: null, position: 'monitor', priority: 'med' },
        ],
      },
      watchlistTerm: {
        findMany: async () => [{ topicId: 'top-1', termType: 'synonym', value: 'grid' }],
      },
    }) as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getWatchlist(TENANT, CLIENT);
    expect(view.topics.map((t) => t.label)).toEqual(['tag']);
  });
});

describe('TrackerWatchlistService.putWatchlist — flat-term isolation', () => {
  /** A prisma double that records the delete/create calls a transaction makes. */
  function recordingPrisma() {
    const calls: Array<{ op: string; args: any }> = [];
    const tx = {
      // write path (the rebuild)…
      watchlist: {
        upsert: async (args: any) => calls.push({ op: 'watchlist.upsert', args }),
        // …plus the getWatchlist re-read putWatchlist runs at the end (empty configured row).
        findFirst: async () => ({ issueAreas: [] }),
      },
      watchlistTopic: {
        deleteMany: async (args: any) => calls.push({ op: 'topic.deleteMany', args }),
        create: async (args: any) => {
          const id = `topic-${calls.length + 1}`;
          calls.push({ op: 'topic.create', args, __id: id } as any);
          return { id };
        },
        findMany: async () => [],
      },
      watchlistTerm: {
        deleteMany: async (args: any) => calls.push({ op: 'term.deleteMany', args }),
        createMany: async (args: any) => calls.push({ op: 'term.createMany', args }),
        findMany: async () => [],
      },
    };
    const prisma = {
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      // withTenant IS a SET-LOCAL $transaction — run the rebuild + re-read with the recording tx.
      withTenant: async (_tid: string, fn: (t: unknown) => unknown) => fn(tx),
      // assertClientInTenant: client belongs to the caller's tenant → guard passes.
      withSystem: async (fn: (t: unknown) => unknown) =>
        fn({ $queryRawUnsafe: async () => [{ id: CLIENT }] }),
    } as any;
    return { prisma, calls };
  }

  it('scopes both deletes to the wl: row only — never touches other watchlists', async () => {
    const { prisma, calls } = recordingPrisma();
    const svc = new TrackerWatchlistService(prisma);

    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: ['Energy'],
      topics: [{ label: 'tag', terms: [{ termType: 'bill', value: '119-hr-1234' }] }],
    });

    const topicDelete = calls.find((c) => c.op === 'topic.deleteMany');
    const termDelete = calls.find((c) => c.op === 'term.deleteMany');
    // Every delete is bounded to watchlistId = wl:<clientId>. Flat terms on OTHER
    // watchlist rows (a different watchlistId) can never match these filters.
    expect(topicDelete?.args.where.watchlistId).toBe(WL_ID);
    expect(termDelete?.args.where.watchlistId).toBe(WL_ID);
    // The flat-term delete is further scoped to topicId: null on THIS row only
    // (the folded hearing terms; a re-save must not duplicate them).
    expect(termDelete?.args.where.topicId).toBeNull();
  });

  it('REJECTS a client not in the caller tenant and makes NO destructive write (batch-A cross-tenant guard)', async () => {
    const calls: Array<{ op: string }> = [];
    const tx = {
      watchlist: { upsert: async () => calls.push({ op: 'watchlist.upsert' }) },
      watchlistTopic: {
        deleteMany: async () => calls.push({ op: 'topic.deleteMany' }),
        create: async () => ({ id: 'x' }),
      },
      watchlistTerm: {
        deleteMany: async () => calls.push({ op: 'term.deleteMany' }),
        createMany: async () => calls.push({ op: 'term.createMany' }),
      },
    };
    const prisma = {
      $transaction: async (fn: (t: unknown) => unknown) => fn(tx),
      // Client does NOT belong to the caller's tenant → guard must throw.
      withSystem: async (fn: (t: unknown) => unknown) => fn({ $queryRawUnsafe: async () => [] }),
    } as any;
    const svc = new TrackerWatchlistService(prisma);

    await expect(
      svc.putWatchlist('attacker-tenant', CLIENT, 'user-1', {
        issueAreas: [],
        topics: [{ label: 'evil', terms: [] }],
      }),
    ).rejects.toThrow('Client not found');
    // The transaction (and thus every delete) must never run.
    expect(calls).toEqual([]);
  });

  it('persists a full 11-type term set under its topic', async () => {
    const { prisma, calls } = recordingPrisma();
    const svc = new TrackerWatchlistService(prisma);

    const allTypes = [
      'bill',
      'agency',
      'committee',
      'legislator',
      'company',
      'competitor',
      'topic',
      'risk_phrase',
      'support_language',
      'opposition_language',
      'program_element',
    ];
    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: [
        { label: 'everything', terms: allTypes.map((t) => ({ termType: t, value: `${t}-value` })) },
      ],
    });

    const createTopic = calls.find((c) => c.op === 'topic.create');
    const createdTopicId = (createTopic as any).__id as string | undefined;
    const createMany = calls.find((c) => c.op === 'term.createMany');
    const persistedTypes = (createMany?.args.data as Array<{ termType: string }>).map(
      (r) => r.termType,
    );
    expect(new Set(persistedTypes)).toEqual(new Set(allTypes));
    // All rows hang off the created topic + the wl: row.
    for (const row of createMany?.args.data as Array<{ watchlistId: string; topicId: string }>) {
      expect(row.watchlistId).toBe(WL_ID);
      expect(row.topicId).toBe(createdTopicId);
    }
  });
});
