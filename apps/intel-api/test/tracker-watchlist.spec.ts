import {
  DEFAULT_TRIGGERS,
  HEARING_TERMS_TOPIC_LABEL,
  TrackerWatchlistService,
} from '../src/tracker/tracker-watchlist.service.js';
import { makeWatchlistStore } from './support/watchlist-store.js';

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
      // `jurisdictions` is part of the head select (State Legislation Platform,
      // DD5) — a double that omits it makes getWatchlist throw on `.length`.
      watchlist: { findFirst: async () => ({ issueAreas: ['Energy'], jurisdictions: [] }) },
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
      watchlist: { findFirst: async () => ({ issueAreas: [], jurisdictions: [] }) },
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
      watchlist: { findFirst: async () => ({ issueAreas: [], jurisdictions: [] }) },
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
  /**
   * A prisma double that records the write calls the reconcile transaction makes.
   * `existingTopics` seeds what `watchlistTopic.findMany` reports as already
   * persisted, so a test can exercise the delete sweep (Gate B phase d step 9).
   */
  function recordingPrisma(existingTopics: Array<{ id: string; label: string }> = []) {
    const calls: Array<{ op: string; args: any }> = [];
    const tx = {
      // write path (the reconcile)…
      watchlist: {
        upsert: async (args: any) => calls.push({ op: 'watchlist.upsert', args }),
        // …plus the getWatchlist re-read putWatchlist runs at the end (empty configured row).
        findFirst: async () => ({ issueAreas: [], jurisdictions: [] }),
      },
      watchlistTopic: {
        deleteMany: async (args: any) => calls.push({ op: 'topic.deleteMany', args }),
        // Gate B phase d: the reconcile upserts per (watchlistId, label) instead
        // of delete-all-then-create, so the double must model upsert + update.
        upsert: async (args: any) => {
          const id = `topic-${calls.length + 1}`;
          calls.push({ op: 'topic.upsert', args, __id: id } as any);
          return { id };
        },
        update: async (args: any) => {
          calls.push({ op: 'topic.update', args });
          return { id: args.where.id };
        },
        findMany: async () => existingTopics,
      },
      watchlistTerm: {
        deleteMany: async (args: any) => calls.push({ op: 'term.deleteMany', args }),
        createMany: async (args: any) => calls.push({ op: 'term.createMany', args }),
        findMany: async () => [],
      },
      // Gate B phase e: every accepted save writes one change-log row, in the
      // same transaction as the reconcile.
      intelWatchlistRevision: {
        create: async (args: any) => calls.push({ op: 'revision.create', args }),
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

  it('scopes EVERY delete to the wl: row only — never touches other watchlists', async () => {
    // Seed a persisted topic the payload omits, so the phase-d delete sweep runs.
    const { prisma, calls } = recordingPrisma([{ id: 'top-old', label: 'gone' }]);
    const svc = new TrackerWatchlistService(prisma);

    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: ['Energy'],
      topics: [{ label: 'tag', terms: [{ termType: 'bill', value: '119-hr-1234' }] }],
    });

    const deletes = calls.filter((c) => c.op.endsWith('.deleteMany'));
    // Boundary §2.4.2 / B2: every delete is bounded to watchlistId = wl:<clientId>
    // AND tenantId, so flat terms or topics on ANY other watchlist row (a
    // different watchlistId — random cuid, old WatchlistsTab) can never match.
    expect(deletes.length).toBeGreaterThan(0);
    for (const d of deletes) {
      expect(d.args.where.watchlistId).toBe(WL_ID);
      expect(d.args.where.tenantId).toBe(TENANT);
    }
    // The removed topic is swept by id, read from a watchlistId-scoped findMany.
    const topicDelete = calls.find((c) => c.op === 'topic.deleteMany');
    expect(topicDelete?.args.where.id).toEqual({ in: ['top-old'] });
    // The flat-term clear is scoped to topicId: null on THIS row only (the folded
    // hearing terms; a re-save must not duplicate them) and runs LAST.
    const flatDelete = calls.filter((c) => c.op === 'term.deleteMany').at(-1);
    expect(flatDelete?.args.where.topicId).toBeNull();
    expect(calls.indexOf(flatDelete!)).toBeGreaterThan(
      calls.findIndex((c) => c.op === 'term.createMany'),
    );
  });

  it('REJECTS a client not in the caller tenant and makes NO destructive write (batch-A cross-tenant guard)', async () => {
    const calls: Array<{ op: string }> = [];
    const tx = {
      watchlist: { upsert: async () => calls.push({ op: 'watchlist.upsert' }) },
      watchlistTopic: {
        deleteMany: async () => calls.push({ op: 'topic.deleteMany' }),
        upsert: async () => ({ id: 'x' }),
        update: async () => ({ id: 'x' }),
        findMany: async () => [],
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

    const createTopic = calls.find((c) => c.op === 'topic.upsert');
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

// The stateful in-memory prisma double lives in test/support/watchlist-store.ts:
// Gate B's watchlist work is almost entirely about what survives BETWEEN saves —
// stable topic ids across an autosave, a rename that keeps its terms, an
// optimistic-concurrency version, the flat-term round-trip — none of which a
// static per-call mock can express.
const statefulPrisma = () => makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT });

/**
 * QA gap-fill: MASTER §2.4 boundary 1 calls the HEARING_TERMS_TOPIC_LABEL fold
 * "load bearing" and says "there is an existing test for this — find it and keep
 * it green." The two older tests (getWatchlist folding, putWatchlist delete
 * scoping) each cover one half with STATIC mocks that do not persist state between
 * calls, so neither actually proves a real get -> put -> get cycle preserves flat
 * terms. This one does.
 */
describe('TrackerWatchlistService — hearing flat-term round-trip (stateful)', () => {

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

  /**
   * Gate B §4.3: the synthetic label is a REAL, saveable label, so a client can
   * hold both flat terms and a same-named persisted topic (the legacy
   * WatchlistsTab can write flat rows at any time). getWatchlist MERGES rather
   * than emitting two topics with one label — a duplicate label in the view would
   * be rejected by the reconcile and the flat rows then cleared, destroying them.
   */
  it('merges flat terms into an existing same-named topic instead of emitting a duplicate label', async () => {
    const { prisma, seedFlatTerm, seedWatchlistRow } = statefulPrisma();
    const svc = new TrackerWatchlistService(prisma);
    seedWatchlistRow();

    // Establish the persisted reserved-label topic the ONLY legitimate way (a
    // flat-term fold-back saved once) — creating it directly is now rejected as a
    // reserved name, which is criterion 3 working.
    seedFlatTerm({ termType: 'agency', value: 'FERC' });
    const folded = await svc.getWatchlist(TENANT, CLIENT);
    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: folded.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    });
    // …and then the legacy tab drops ANOTHER flat term on the same row.
    seedFlatTerm({ termType: 'topic', value: 'interconnection queue' });

    const view = await svc.getWatchlist(TENANT, CLIENT);
    expect(view.topics).toHaveLength(1);
    expect(view.topics[0]!.label).toBe(HEARING_TERMS_TOPIC_LABEL);
    expect(view.topics[0]!.terms.map((t) => t.value).sort()).toEqual([
      'FERC',
      'interconnection queue',
    ]);

    // Saving that view back keeps both terms exactly once — no loss, no growth.
    await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: view.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    });
    const after = await svc.getWatchlist(TENANT, CLIENT);
    expect(after.topics).toHaveLength(1);
    expect(after.topics[0]!.terms.map((t) => t.value).sort()).toEqual([
      'FERC',
      'interconnection queue',
    ]);
  });
});

/**
 * Gate B phase d (P0-03 item 5, P1-02) — the label-keyed reconcile. Before this
 * phase putWatchlist deleted every topic and re-created it with a fresh cuid on
 * every autosave, so no topic id was ever stable and a rename was
 * indistinguishable from delete+create.
 */
describe('TrackerWatchlistService.putWatchlist — label-keyed reconcile (phase d)', () => {
  const save = (svc: TrackerWatchlistService, topics: unknown[]) =>
    svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: topics as never,
    });

  it('d-4.1 is idempotent: two identical saves leave identical rows AND identical topic ids', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    const payload = [
      { label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] },
      { label: 'beta', terms: [{ termType: 'company', value: 'RTX' }] },
    ];

    await save(svc, payload);
    const first = h.snapshot();
    await save(svc, payload);
    const second = h.snapshot();

    expect(second.topics.map((t) => t.id).sort()).toEqual(first.topics.map((t) => t.id).sort());
    expect(second.terms.map((t) => t.id).sort()).toEqual(first.terms.map((t) => t.id).sort());
    // Not one term write on the second pass — the set was unchanged.
    expect(h.ops.slice(h.ops.indexOf('watchlist.upsert', 1))).not.toContain('term.createMany');
  });

  it('d-4.2 a rename preserves the topic id and its terms', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    const terms = [
      { termType: 'topic', value: 'grid load' },
      { termType: 'agency', value: 'FERC' },
    ];
    await save(svc, [{ label: 'alpha', terms }]);
    const before = h.snapshot();
    const alphaId = before.topics[0]!.id;
    const termIds = before.terms.map((t) => t.id).sort();

    await save(svc, [{ label: 'beta', renameFrom: 'alpha', terms }]);
    const after = h.snapshot();

    expect(after.topics).toHaveLength(1);
    expect(after.topics[0]!.id).toBe(alphaId); // the id survived
    expect(after.topics[0]!.label).toBe('beta');
    expect(after.terms.map((t) => t.id).sort()).toEqual(termIds); // so did the terms
    const view = await svc.getWatchlist(TENANT, CLIENT);
    expect(view.topics[0]!.terms.map((t) => t.value).sort()).toEqual(['FERC', 'grid load']);
  });

  it('d-4.3 a rename ONTO a live label is rejected, leaves both topics intact, and never surfaces P2002', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    await save(svc, [
      { label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] },
      { label: 'beta', terms: [{ termType: 'company', value: 'RTX' }] },
    ]);
    const before = h.snapshot();

    // Rename alpha → beta while beta still exists. `alpha` is NOT sent as its own
    // entry, so §4.6's protection is what keeps it from being swept.
    const view = await svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: [
        { label: 'beta', renameFrom: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] },
      ],
    });

    expect(view.rejected?.topics).toEqual([
      { index: 0, label: 'beta', reason: 'Duplicate tag name.' },
    ]);
    const after = h.snapshot();
    expect(after.topics.map((t) => t.label).sort()).toEqual(['alpha', 'beta']);
    expect(after.topics.map((t) => t.id).sort()).toEqual(before.topics.map((t) => t.id).sort());
    expect(after.terms.map((t) => `${t.termType} ${t.value}`).sort()).toEqual(
      before.terms.map((t) => `${t.termType} ${t.value}`).sort(),
    );
  });

  it('d-4.4 removing a topic deletes it and its terms, and leaves the kept topic byte-identical', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    await save(svc, [
      { label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] },
      { label: 'beta', terms: [{ termType: 'company', value: 'RTX' }] },
    ]);
    const before = h.snapshot();
    const alpha = before.topics.find((t) => t.label === 'alpha')!;
    const alphaTerms = before.terms.filter((t) => t.topicId === alpha.id);

    await save(svc, [{ label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] }]);
    const after = h.snapshot();

    expect(after.topics.map((t) => t.label)).toEqual(['alpha']);
    expect(after.topics[0]!.id).toBe(alpha.id);
    // The cascade removed beta's terms; alpha's rows kept their ids AND createdAt.
    expect(after.terms).toEqual(alphaTerms);
  });

  it('d-4.6 another watchlist row for the same client is byte-identical afterwards', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    h.seedWatchlistRow();
    h.seedForeignRow('clx-legacy-row-id');
    const foreignBefore = JSON.stringify({
      topics: h.snapshot().topics.filter((t) => t.watchlistId === 'clx-legacy-row-id'),
      terms: h.snapshot().terms.filter((t) => t.watchlistId === 'clx-legacy-row-id'),
    });

    await save(svc, [{ label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] }]);

    const foreignAfter = JSON.stringify({
      topics: h.snapshot().topics.filter((t) => t.watchlistId === 'clx-legacy-row-id'),
      terms: h.snapshot().terms.filter((t) => t.watchlistId === 'clx-legacy-row-id'),
    });
    expect(foreignAfter).toBe(foreignBefore);
  });

  it('d-4.7 a blank label is not created and IS reported in rejected.topics', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);

    const view = await save(svc, [
      { label: '   ', terms: [{ termType: 'topic', value: 'grid load' }] },
      { label: 'real', terms: [] },
    ]);

    expect(view.topics.map((t) => t.label)).toEqual(['real']);
    expect(view.rejected?.topics).toEqual([
      { index: 0, label: '   ', reason: 'A tag needs a name.' },
    ]);
  });

  it('d-4.8 case-insensitively duplicate incoming labels collapse to one topic, the later one reported', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);

    const view = await save(svc, [
      { label: 'AI', terms: [{ termType: 'topic', value: 'autonomy' }] },
      { label: 'ai', terms: [{ termType: 'topic', value: 'machine learning' }] },
    ]);

    expect(view.topics.map((t) => t.label)).toEqual(['AI']);
    expect(view.topics[0]!.terms.map((t) => t.value)).toEqual(['autonomy']);
    expect(view.rejected?.topics).toEqual([{ index: 1, label: 'ai', reason: 'Duplicate tag name.' }]);
  });

  it('d-4.9 a foreign tenant still 404s before any write (assertClientInTenant is first)', async () => {
    // clientRows: [] → the ownership lookup finds nothing, as for a foreign tenant.
    const h = makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT, clientRows: [] });
    const svc = new TrackerWatchlistService(h.prisma as never);

    await expect(save(svc, [{ label: 'evil', terms: [] }])).rejects.toThrow('Client not found');
    expect(h.ops).toEqual([]);
  });

  it('§4.4 a renameFrom pointing at a label that no longer exists becomes a create, not a throw', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);

    const view = await save(svc, [
      { label: 'beta', renameFrom: 'never-existed', terms: [{ termType: 'topic', value: 'grid' }] },
    ]);

    expect(view.rejected?.topics).toEqual([]);
    expect(view.topics.map((t) => t.label)).toEqual(['beta']);
    expect(view.topics[0]!.terms.map((t) => t.value)).toEqual(['grid']);
  });

  it('§4.6 a rename and a delete of the same label in one payload renames, never deletes', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma);
    await save(svc, [
      { label: 'alpha', terms: [{ termType: 'topic', value: 'grid' }] },
      { label: 'gamma', terms: [] },
    ]);
    const alphaId = h.snapshot().topics.find((t) => t.label === 'alpha')!.id;

    // `alpha` is absent as its own entry (a delete) but is the rename SOURCE.
    await save(svc, [{ label: 'beta', renameFrom: 'alpha', terms: [{ termType: 'topic', value: 'grid' }] }]);

    const after = h.snapshot();
    expect(after.topics.map((t) => t.label)).toEqual(['beta']); // gamma removed, alpha renamed
    expect(after.topics[0]!.id).toBe(alphaId);
  });

  it('does not grow the row on a re-save when the same term arrives twice in one topic', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);

    await save(svc, [
      {
        label: 'alpha',
        terms: [
          { termType: 'topic', value: 'grid load' },
          { termType: 'topic', value: 'grid load' },
        ],
      },
    ]);

    expect(h.snapshot().terms).toHaveLength(1);
  });
});

/**
 * Gate B phase e (P1-02) — optimistic concurrency on SHARED targeting. Two
 * analysts editing the same client used to silently overwrite each other, because
 * the editor autosaves a full replacement 600ms after any keystroke.
 */
describe('TrackerWatchlistService — watchlist versioning + change log (phase e)', () => {
  const put = (
    svc: TrackerWatchlistService,
    topics: unknown[],
    expectedVersion?: number,
  ) =>
    svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: topics as never,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });

  it('e-10.8 getWatchlist reports version 0 for a never-configured client', async () => {
    const prisma = tenantReader({ watchlist: { findFirst: async () => null } }) as any;
    const view = await new TrackerWatchlistService(prisma).getWatchlist(TENANT, CLIENT);
    expect(view).toMatchObject({ version: 0, updatedByName: null, updatedAt: null });
  });

  it('e-10.1/2 the first PUT with expectedVersion 0 succeeds and the version increments', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);

    const first = await put(svc, [{ label: 'alpha', terms: [] }], 0);
    expect(first.version).toBe(1);
    // Attribution is the resolved display NAME (the store's users double), never the id.
    expect(first.updatedByName).toBe('Ada Lovelace');

    const second = await put(svc, [{ label: 'alpha', terms: [] }, { label: 'beta', terms: [] }], 1);
    expect(second.version).toBe(2);
  });

  it('e-10.3 a stale expectedVersion 409s with the code + currentVersion and changes NOTHING', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    await put(svc, [{ label: 'alpha', terms: [] }], 0); // now at version 1
    await put(svc, [{ label: 'alpha', terms: [] }, { label: 'beta', terms: [] }], 1); // version 2
    const before = h.snapshot();

    // A second analyst who read at version 1 tries to save their own view.
    let err: unknown;
    try {
      await put(svc, [{ label: 'their-own-tag', terms: [] }], 1);
    } catch (e) {
      err = e;
    }

    expect((err as { status?: number })?.status).toBe(409);
    expect((err as { response?: unknown }).response).toMatchObject({
      code: 'WATCHLIST_VERSION_CONFLICT',
      currentVersion: 2,
    });
    const after = h.snapshot();
    expect(after.topics.map((t) => t.label).sort()).toEqual(['alpha', 'beta']);
    expect(after.head?.version).toBe(2);
    expect(after.terms).toEqual(before.terms);
  });

  it('e-10.4 an OMITTED expectedVersion is accepted (an un-updated bundle is not hard-broken)', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    await put(svc, [{ label: 'alpha', terms: [] }], 0);

    const view = await put(svc, [{ label: 'alpha', terms: [] }, { label: 'beta', terms: [] }]);

    expect(view.version).toBe(2);
    expect(view.topics.map((t) => t.label).sort()).toEqual(['alpha', 'beta']);
  });

  it('e-10.5/6 each accepted save writes exactly one revision; a rejected one writes none', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);

    await put(svc, [{ label: 'alpha', terms: [{ termType: 'topic', value: 'grid load' }] }], 0);
    expect(h.revisions).toHaveLength(1);
    expect(h.revisions[0]).toMatchObject({ version: 1, changedBy: 'user-1', clientId: CLIENT });
    expect(h.revisions[0]!['summary']).toMatchObject({ topics: 1, terms: 1 });

    // A rename + a delete, so the summary carries the label-level diff.
    await put(svc, [{ label: 'beta', renameFrom: 'alpha', terms: [] }], 1);
    expect(h.revisions).toHaveLength(2);
    expect(h.revisions[1]!['summary']).toMatchObject({ renamed: [{ from: 'alpha', to: 'beta' }] });

    await expect(put(svc, [{ label: 'gamma', terms: [] }], 0)).rejects.toThrow();
    expect(h.revisions).toHaveLength(2); // the conflict wrote nothing
  });

  it('e-10.7 getRevisions returns newest-first, capped at 20, and 404s a foreign tenant', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    for (let v = 0; v < 22; v += 1) {
      await put(svc, [{ label: `tag-${v}`, terms: [] }], v);
    }

    const rows = await svc.getRevisions(TENANT, CLIENT);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.version).toBe(22);
    expect(rows.at(-1)!.version).toBe(3);
    expect(rows.map((r) => r.version)).toEqual([...rows.map((r) => r.version)].sort((a, b) => b - a));

    const foreign = makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT, clientRows: [] });
    await expect(
      new TrackerWatchlistService(foreign.prisma as never).getRevisions(TENANT, CLIENT),
    ).rejects.toThrow('Client not found');
  });

  it('attributes by resolved NAME and never exposes the Clerk id in the response shape', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    const view = await put(svc, [{ label: 'alpha', terms: [] }], 0);
    expect(view.updatedByName).toBe('Ada Lovelace');
    expect(typeof view.updatedAt).toBe('string');
    // e-8: the id must not be reachable at all, not merely unrendered.
    expect(Object.keys(view)).not.toContain('updatedBy');
    expect(JSON.stringify(view)).not.toContain('user-1');
  });
});

/**
 * P1-01 (Gate A phase e) — a never-configured pref must default to the
 * shipped trigger set, not zero triggers, and a deliberate `[]` clear must
 * still survive (the `??` vs `||` distinction — see tracker-watchlist.service.ts).
 */
/**
 * Follow-ups closed after the Gate B live smoke (2026-07-26), at Neo's direction:
 * §5.1 criterion 3 (the reserved label) and P1-02's permission split. Both were
 * previously reported as deliberate deviations.
 */
describe('TrackerWatchlistService — reserved topic label (criterion 3)', () => {
  const put = (svc: TrackerWatchlistService, topics: unknown[]) =>
    svc.putWatchlist(TENANT, CLIENT, 'user-1', { issueAreas: [], topics: topics as never });

  it('rejects the reserved label for a NEW tag when the client has no flat terms', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);

    const view = await put(svc, [
      { label: 'grid', terms: [] },
      { label: HEARING_TERMS_TOPIC_LABEL, terms: [{ termType: 'topic', value: 'sneaky' }] },
    ]);

    expect(view.topics.map((t) => t.label)).toEqual(['grid']);
    expect(view.rejected?.topics).toEqual([
      { index: 1, label: HEARING_TERMS_TOPIC_LABEL, reason: '"Hearing terms" is a reserved name.' },
    ]);
  });

  it('is case-insensitive about the reserved label', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    const view = await put(svc, [{ label: 'hEaRiNg TeRmS', terms: [] }]);
    expect(view.topics).toHaveLength(0);
    expect(view.rejected?.topics[0]?.reason).toContain('reserved');
  });

  it('ACCEPTS the reserved label when it is the fold-back of real flat terms (no data loss)', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    h.seedWatchlistRow();
    h.seedFlatTerm({ termType: 'agency', value: 'FERC' });

    // Exactly what the editor round-trips: getWatchlist folded the flat term under
    // the synthetic label, so the save must persist it rather than reject it.
    const read = await svc.getWatchlist(TENANT, CLIENT);
    const view = await put(
      svc,
      read.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    );

    expect(view.rejected?.topics).toEqual([]);
    expect(view.topics.map((t) => t.label)).toEqual([HEARING_TERMS_TOPIC_LABEL]);
    expect(view.topics[0]!.terms.map((t) => t.value)).toEqual(['FERC']);
  });

  it('ACCEPTS the reserved label once a topic already carries it (never breaks existing data)', async () => {
    const h = statefulPrisma();
    const svc = new TrackerWatchlistService(h.prisma as never);
    h.seedWatchlistRow();
    h.seedFlatTerm({ termType: 'agency', value: 'FERC' });
    const read = await svc.getWatchlist(TENANT, CLIENT);
    await put(
      svc,
      read.topics.map((t) => ({
        label: t.label,
        terms: t.terms.map((x) => ({ termType: x.termType, value: x.value })),
      })),
    );
    // The flat rows are gone now — the label survives only as a persisted topic.
    const second = await put(svc, [
      { label: HEARING_TERMS_TOPIC_LABEL, terms: [{ termType: 'agency', value: 'FERC' }] },
    ]);
    expect(second.rejected?.topics).toEqual([]);
    expect(second.topics.map((t) => t.label)).toEqual([HEARING_TERMS_TOPIC_LABEL]);
  });
});

describe('TrackerWatchlistService — targeting is admin-only (P1-02 permission split)', () => {
  const prismaWithRole = (membershipRole: string | null) =>
    makeWatchlistStore({ tenantId: TENANT, clientId: CLIENT, membershipRole });
  const put = (svc: TrackerWatchlistService) =>
    svc.putWatchlist(TENANT, CLIENT, 'user-1', {
      issueAreas: [],
      topics: [{ label: 'grid', terms: [] }],
    });

  it.each(['user_admin', 'capiro_admin'])('allows an admin (%s) to edit targeting', async (role) => {
    const h = prismaWithRole(role);
    await expect(put(new TrackerWatchlistService(h.prisma as never))).resolves.toMatchObject({
      version: 1,
    });
  });

  it('403s a standard_user and writes NOTHING', async () => {
    const h = prismaWithRole('standard_user');
    const svc = new TrackerWatchlistService(h.prisma as never);

    await expect(put(svc)).rejects.toMatchObject({ status: 403 });
    // Fail-closed BEFORE the transaction: no topic, no revision, no version bump.
    expect(h.ops).toEqual([]);
    expect(h.revisions).toEqual([]);
  });

  it('fails OPEN when the caller has no membership row (a lockout is worse than an edit)', async () => {
    const h = prismaWithRole(null);
    await expect(put(new TrackerWatchlistService(h.prisma as never))).resolves.toMatchObject({
      version: 1,
    });
  });
});

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
