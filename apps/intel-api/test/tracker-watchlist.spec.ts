import {
  DEFAULT_TRIGGERS,
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
        findFirst: async () => ({ issueAreas: [], jurisdictions: [] }),
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

  /** P0-05 (Gate B phase a) — the term-shape-aware filter replacing flat MIN_TERM_LEN. */
  it('persists an identifier-shaped short term ("AI") that the old flat length check dropped', async () => {
    const { prisma, calls } = recordingPrisma();
    const svc = new TrackerWatchlistService(prisma);

    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: [{ label: 'signals', terms: [{ termType: 'topic', value: 'AI' }] }],
    });

    const createMany = calls.find((c) => c.op === 'term.createMany');
    const values = (createMany?.args.data as Array<{ value: string }>).map((r) => r.value);
    expect(values).toEqual(['AI']);
  });

  it('drops a lower-case fragment ("of") and reports it in rejected.terms with a reason', async () => {
    const { prisma } = recordingPrisma();
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: [{ label: 'signals', terms: [{ termType: 'topic', value: 'of' }] }],
    });

    expect(view.rejected?.terms).toHaveLength(1);
    expect(view.rejected?.terms[0]).toMatchObject({ topicLabel: 'signals', termType: 'topic', value: 'of' });
    expect(view.rejected?.terms[0]?.reason).toContain('too short');
  });
});

/**
 * QA gap-fill (not in the phase-a task list): MASTER §2.4 boundary 1 calls the
 * HEARING_TERMS_TOPIC_LABEL fold "load bearing" and says "there is an existing
 * test for this — find it and keep it green." The existing tests
 * (getWatchlist folding, putWatchlist delete-scoping) each cover one half with
 * STATIC mocks that don't persist state between calls, so neither actually
 * proves a real get -> put -> get cycle preserves flat terms. This is a
 * stateful in-memory double that does.
 */
describe('TrackerWatchlistService — hearing flat-term round-trip (stateful)', () => {
  function statefulPrisma() {
    let watchlist: { id: string; tenantId: string; issueAreas: string[]; jurisdictions: string[] } | null = null;
    let topics: Array<{
      id: string;
      watchlistId: string;
      tenantId: string;
      label: string;
      issueArea: string | null;
      position: string;
      priority: string;
    }> = [];
    let terms: Array<{
      id: string;
      watchlistId: string;
      tenantId: string;
      topicId: string | null;
      termType: string;
      value: string;
    }> = [];
    let nextId = 1;

    const tx = {
      watchlist: {
        upsert: async ({ where, create, update }: any) => {
          if (!watchlist) {
            watchlist = {
              id: where.id,
              tenantId: create.tenantId,
              issueAreas: create.issueAreas,
              jurisdictions: create.jurisdictions,
            };
          } else {
            Object.assign(watchlist, update);
          }
          return watchlist;
        },
        findFirst: async ({ where }: any) =>
          watchlist && watchlist.id === where.id && watchlist.tenantId === where.tenantId
            ? { issueAreas: watchlist.issueAreas, jurisdictions: watchlist.jurisdictions }
            : null,
      },
      watchlistTopic: {
        deleteMany: async ({ where }: any) => {
          topics = topics.filter((t) => !(t.watchlistId === where.watchlistId && t.tenantId === where.tenantId));
        },
        create: async ({ data }: any) => {
          const id = `topic-${nextId++}`;
          topics.push({ id, ...data });
          return { id };
        },
        findMany: async ({ where }: any) =>
          topics
            .filter((t) => t.watchlistId === where.watchlistId && t.tenantId === where.tenantId)
            .map((t) => ({ id: t.id, label: t.label, issueArea: t.issueArea, position: t.position, priority: t.priority })),
      },
      watchlistTerm: {
        deleteMany: async ({ where }: any) => {
          terms = terms.filter((x) => {
            if (x.watchlistId !== where.watchlistId || x.tenantId !== where.tenantId) return true;
            if (Object.prototype.hasOwnProperty.call(where, 'topicId') && where.topicId === null) {
              return x.topicId !== null; // keep everything that is NOT a flat term
            }
            return false; // unscoped delete (topic rebuild) — drop everything matched
          });
        },
        createMany: async ({ data }: any) => {
          for (const row of data) terms.push({ id: `term-${nextId++}`, ...row });
        },
        findMany: async ({ where }: any) => {
          const scopedTopicIds = topics
            .filter((t) => t.watchlistId === where.watchlistId && t.tenantId === where.tenantId)
            .map((t) => t.id);
          return terms
            .filter((x) => x.watchlistId === where.watchlistId && x.tenantId === where.tenantId)
            .filter((x) => x.topicId === null || scopedTopicIds.includes(x.topicId as string))
            .map((x) => ({ topicId: x.topicId, termType: x.termType, value: x.value }));
        },
      },
    };
    const prisma = {
      withTenant: async (_tid: string, fn: (t: unknown) => unknown) => fn(tx),
      withSystem: async (fn: (t: unknown) => unknown) => fn({ $queryRawUnsafe: async () => [{ id: CLIENT }] }),
    } as any;
    // Expose the raw stores so the test can seed legacy flat (topicId: null) rows —
    // the one thing putWatchlist itself can never write (it always attaches a topicId).
    return { prisma, seedFlatTerm: (row: { termType: string; value: string }) => {
      terms.push({ id: `term-${nextId++}`, watchlistId: WL_ID, tenantId: TENANT, topicId: null, ...row });
    }, seedWatchlistRow: () => {
      watchlist = { id: WL_ID, tenantId: TENANT, issueAreas: [], jurisdictions: [] };
    } };
  }

  it('flat (topicId: null) hearing terms fold on read, survive a save, and do not duplicate on a second get/put cycle', async () => {
    const { prisma, seedFlatTerm, seedWatchlistRow } = statefulPrisma();
    const svc = new TrackerWatchlistService(prisma);

    // Simulate the legacy WatchlistsTab having written two flat terms directly.
    seedWatchlistRow();
    seedFlatTerm({ termType: 'topic', value: 'interconnection queue' });
    seedFlatTerm({ termType: 'agency', value: 'FERC' });

    const firstRead = await svc.getWatchlist(TENANT, CLIENT);
    const syntheticFirst = firstRead.topics.find((t) => t.label === HEARING_TERMS_TOPIC_LABEL);
    expect(syntheticFirst?.terms.map((t) => t.value).sort()).toEqual(['FERC', 'interconnection queue']);

    // Save back exactly what the editor would have received (server-normalized view).
    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: firstRead.issueAreas,
      topics: firstRead.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    });

    const secondRead = await svc.getWatchlist(TENANT, CLIENT);
    expect(secondRead.topics).toHaveLength(1); // no phantom duplicate "Hearing terms" topic
    const syntheticSecond = secondRead.topics.find((t) => t.label === HEARING_TERMS_TOPIC_LABEL);
    expect(syntheticSecond?.terms.map((t) => t.value).sort()).toEqual(['FERC', 'interconnection queue']); // no loss, no dup

    // Third cycle: save again, unchanged — must remain stable (no growth, no loss).
    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: secondRead.issueAreas,
      topics: secondRead.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    });
    const thirdRead = await svc.getWatchlist(TENANT, CLIENT);
    expect(thirdRead.topics).toHaveLength(1);
    expect(thirdRead.topics[0]?.terms.map((t) => t.value).sort()).toEqual(['FERC', 'interconnection queue']);
  });
});

/**
 * P1-01 (Gate A phase e) — a never-configured pref must default to the
 * shipped trigger set, not zero triggers, and a deliberate `[]` clear must
 * still survive (the `??` vs `||` distinction — see tracker-watchlist.service.ts).
 */
describe('TrackerWatchlistService.getAlertPrefs — P1-01 default triggers', () => {
  it('returns DEFAULT_TRIGGERS for a client with no pref row', async () => {
    const prisma = {
      withTenant: async (_tid: string, fn: (t: unknown) => unknown) =>
        fn({ intelAlertPreference: { findUnique: async () => null } }),
    } as any;
    const svc = new TrackerWatchlistService(prisma);

    const view = await svc.getAlertPrefs(TENANT, CLIENT, 'user-1');

    expect(view.triggers).toEqual([...DEFAULT_TRIGGERS]);
  });
});

describe('TrackerWatchlistService.putAlertPrefs — P1-01 default vs deliberate clear', () => {
  function recordingPrefsPrisma() {
    const upserts: Array<{ create: unknown; update: unknown }> = [];
    const prisma = {
      // assertClientInTenant: client belongs to the caller's tenant → guard passes.
      withSystem: async (fn: (t: unknown) => unknown) =>
        fn({ $queryRawUnsafe: async () => [{ id: CLIENT }] }),
      // assertPrefRowTenant's read (no existing row) + the upsert write.
      withTenant: async (_tid: string, fn: (t: unknown) => unknown) =>
        fn({
          intelAlertPreference: {
            findUnique: async () => null,
            upsert: async (args: { create: unknown; update: unknown }) => {
              upserts.push(args);
              return args.create;
            },
          },
        }),
    } as any;
    return { prisma, upserts };
  }

  it('triggers omitted → creates a row with DEFAULT_TRIGGERS', async () => {
    const { prisma, upserts } = recordingPrefsPrisma();
    const svc = new TrackerWatchlistService(prisma);

    await svc.putAlertPrefs(TENANT, CLIENT, 'user-1', {});

    expect((upserts[0]!.create as { triggers: string[] }).triggers).toEqual([...DEFAULT_TRIGGERS]);
  });

  it('triggers: [] → the deliberate clear survives (creates/updates a row with [])', async () => {
    const { prisma, upserts } = recordingPrefsPrisma();
    const svc = new TrackerWatchlistService(prisma);

    await svc.putAlertPrefs(TENANT, CLIENT, 'user-1', { triggers: [] });

    expect((upserts[0]!.create as { triggers: string[] }).triggers).toEqual([]);
  });
});
