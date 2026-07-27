import { FeedService, encodeCursor, DEFAULT_STATUSES } from '../src/feed/feed.service.js';

// Crypto stub that never decrypts (feed decrypt-on-read is a no-op).
const NO_CRYPTO = { configured: false, decrypt: () => '' } as any;
// Action-state stub: no memos/talking-points/report flags on any alert.
// (FeedService grew the ActionItemService dep with the alert-actions feature;
// this spec predated it and constructed FeedService without it.)
const NO_ACTIONS = { summaryForAlerts: async () => new Map() } as any;
// SourceData stub: no client-name resolution (P11 global roll-up dep). Per-client
// tests never hit it (clientId short-circuits name resolution).
const NO_SOURCE_DATA = { getClientNames: async () => new Map() } as any;
// WorkState stub: FeedService's 5th constructor dep (AlertWorkStateService).
// None of the tests above pass a userId, so `forAlerts`/`hiddenAlertIds` are
// never dereferenced on this stub — it exists only so the constructor call is
// arity-correct. See makeWorkStateStub below for the tests that DO exercise it.
const NO_WORK_STATE = {
  hiddenAlertIds: async () => [],
  alertIdsInState: async () => [],
  forAlerts: async () => new Map(),
} as any;

/** For tests that pass a userId and need to control what work-state comes back. */
function makeWorkStateStub(overrides: {
  hiddenAlertIds?: (...args: any[]) => Promise<string[]>;
  alertIdsInState?: (...args: any[]) => Promise<string[]>;
  forAlerts?: (...args: any[]) => Promise<Map<string, any>>;
} = {}) {
  const calls = { hiddenAlertIds: [] as any[], alertIdsInState: [] as any[], forAlerts: [] as any[] };
  return {
    hiddenAlertIds: async (...args: any[]) => {
      calls.hiddenAlertIds.push(args);
      return overrides.hiddenAlertIds ? overrides.hiddenAlertIds(...args) : [];
    },
    alertIdsInState: async (...args: any[]) => {
      calls.alertIdsInState.push(args);
      return overrides.alertIdsInState ? overrides.alertIdsInState(...args) : [];
    },
    forAlerts: async (...args: any[]) => {
      calls.forAlerts.push(args);
      return overrides.forAlerts ? overrides.forAlerts(...args) : new Map();
    },
    calls,
  };
}

function mockPrisma(rows: any[], groups?: any[], terms?: any[]) {
  let lastArgs: any = null;
  const tx = {
    intelAlert: {
      findMany: async (args: any) => {
        lastArgs = args;
        return rows.slice(0, args.take);
      },
      groupBy: async () => groups ?? [],
    },
    watchlistTerm: { findMany: async () => terms ?? [] },
    transcriptSegment: { findMany: async () => [] },
  };
  // FeedService runs every query through prisma.withTenant(tenantId, cb). This spec
  // predated that refactor and mocked the delegates directly, so every getFeed test in
  // it threw "withTenant is not a function". Route the callback at the tx above.
  const prisma = { ...tx, withTenant: async (_t: string, cb: any) => cb(tx) } as any;
  return { prisma, getArgs: () => lastArgs };
}
const mkRow = (i: number, score: number, clientId = 'c1') => ({
  id: `id${i}`,
  clientId,
  sourceType: 'bill',
  kind: 'bill',
  severity: 'notable',
  materiality: 'medium',
  score,
  clientImpact: 'monitor',
  urgency: 'med',
  title: `t${i}`,
  whyItMatters: null,
  recommendedAction: null,
  evidence: {},
  status: 'new',
  createdAt: new Date(Date.UTC(2026, 5, 24, 0, 0, i)),
});

describe('encodeCursor', () => {
  it('encodes {t,id} for date order', () => {
    const o = JSON.parse(Buffer.from(encodeCursor('date', { score: 0.5, createdAt: new Date('2026-06-24T18:00:00Z'), id: 'a1' }), 'base64url').toString());
    expect(o).toEqual({ t: '2026-06-24T18:00:00.000Z', id: 'a1' });
  });
  it('encodes {s,t,id} for score order', () => {
    const o = JSON.parse(Buffer.from(encodeCursor('score', { score: 0.82, createdAt: new Date('2026-06-24T18:00:00Z'), id: 'a1' }), 'base64url').toString());
    expect(o.s).toBe(0.82);
    expect(o.id).toBe('a1');
  });
});

describe('FeedService.getFeed', () => {
  it('always filters tenantId + clientId and applies default statuses', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)], [{ sourceType: 'bill', _count: 1 }]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    const w = getArgs().where;
    expect(w.tenantId).toBe('t1');
    expect(w.clientId).toBe('c1');
    expect(w.status).toEqual({ in: DEFAULT_STATUSES });
  });

  it('computes hasMore + nextCursor from the extra row', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 26 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', { limit: 25 });
    expect(r.items).toHaveLength(25);
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBeTruthy();
  });

  it('has no next page when rows ≤ limit', async () => {
    const { prisma } = mockPrisma(Array.from({ length: 10 }, (_, i) => mkRow(i, 0.5)));
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', { limit: 25 });
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
  });

  it('builds a 2-part keyset for date order', async () => {
    const cursor = encodeCursor('date', { score: 0.5, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', { order: 'date', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(2);
  });

  it('builds a 3-part keyset for score order', async () => {
    const cursor = encodeCursor('score', { score: 0.7, createdAt: new Date('2026-06-24T00:00:00Z'), id: 'idX' });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', { order: 'score', cursor });
    const a = getArgs();
    expect(a.orderBy).toEqual([{ score: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(3);
  });

  it('clamps limit to 100', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', { limit: 9999 });
    expect(getArgs().take).toBe(101);
  });

  it('applies sourceType/severity/date filters and maps counts', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)], [{ sourceType: 'bill', _count: 12 }, { sourceType: 'combined', _count: 3 }]);
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {
      sourceTypes: ['combined'],
      severities: ['critical'],
      since: new Date('2026-06-01'),
      until: new Date('2026-07-01'),
    });
    const w = getArgs().where;
    expect(w.sourceType).toEqual({ in: ['combined'] });
    expect(w.severity).toEqual({ in: ['critical'] });
    expect(w.createdAt.gte).toBeInstanceOf(Date);
    expect(w.createdAt.lt).toBeInstanceOf(Date);
    expect(r.counts).toEqual({ bill: 12, combined: 3 });
  });

  // Gate F phase b: FeedService's constructor takes 5 args (the 5th is
  // AlertWorkStateService). This test is the regression lock — it is the only
  // one in this file that passes a userId, so it is the only one that would
  // throw "Cannot read properties of undefined" if the arity ever drifts back
  // to 4 (as it silently did for every other test in this file before this
  // phase — none of them touch `this.workState` because none of them set
  // userId, so a missing 5th arg was never caught).
  it('consults the work-state dependency when userId is set (constructor arity lock)', async () => {
    const { prisma } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub();
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1',
      'c1',
      { userId: 'u1' },
    );
    expect(workState.calls.hiddenAlertIds).toHaveLength(1);
    expect(workState.calls.hiddenAlertIds[0]).toEqual(['t1', 'u1', 'c1']);
    expect(workState.calls.forAlerts).toHaveLength(1);
  });
});

/**
 * Gate F c-7 (RB-01): one case per WORK_FILTERS option, proving getFeed builds
 * a DIFFERENT, CORRECT id predicate for each — not the pre-fix reality where
 * 6 of 8 options were byte-identical to `default`. Each test asserts on the
 * args passed to intelAlert.findMany (mockPrisma does not itself filter by
 * `where` — see its definition above), which is exactly the layer this bug
 * lived in: the predicate that never got built. The QUERY LOGIC behind each
 * predicate (which rows alertIdsInState/hiddenAlertIds actually return) is
 * covered separately in alert-work-state.spec.ts.
 */
describe('FeedService.getFeed — work-state filtering (RB-01)', () => {
  it('default (no workStates): excludes hiddenAlertIds via notIn', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub({ hiddenAlertIds: async () => ['h1', 'h2'] });
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { userId: 'u1' },
    );
    expect(getArgs().where.id).toEqual({ notIn: ['h1', 'h2'] });
    expect(workState.calls.alertIdsInState).toHaveLength(0); // default never calls alertIdsInState
  });

  it("'all': no id predicate at all, no work-state call made", async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub();
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { userId: 'u1', workStates: ['all'] },
    );
    expect(getArgs().where.id).toBeUndefined();
    expect(workState.calls.hiddenAlertIds).toHaveLength(0);
    expect(workState.calls.alertIdsInState).toHaveLength(0);
  });

  it("'new': anti-join over NOT_NEW_STATES via notIn", async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub({ alertIdsInState: async () => ['t1', 't2', 't3'] });
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { userId: 'u1', workStates: ['new'] },
    );
    expect(getArgs().where.id).toEqual({ notIn: ['t1', 't2', 't3'] });
    expect(workState.calls.alertIdsInState[0]).toEqual([
      't1', 'u1', 'c1', ['in_review', 'assigned', 'actioned', 'dismissed', 'snoozed'],
    ]);
  });

  it.each(['in_review', 'assigned', 'actioned', 'dismissed', 'snoozed'])(
    "'%s': positive filter via in",
    async (filter) => {
      const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
      const workState = makeWorkStateStub({ alertIdsInState: async () => ['m1', 'm2'] });
      await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
        't1', 'c1', { userId: 'u1', workStates: [filter] },
      );
      expect(getArgs().where.id).toEqual({ in: ['m1', 'm2'] });
      expect(workState.calls.alertIdsInState[0]).toEqual(['t1', 'u1', 'c1', [filter]]);
    },
  );

  it('a positive filter with NO matches produces id:{in:[]} — zero rows, never falls through to default', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub({ alertIdsInState: async () => [] });
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { userId: 'u1', workStates: ['dismissed'] },
    );
    expect(getArgs().where.id).toEqual({ in: [] });
  });

  it('no userId: no work-state call, no id predicate, regardless of workStates', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5)]);
    const workState = makeWorkStateStub();
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { workStates: ['dismissed'] },
    );
    expect(getArgs().where.id).toBeUndefined();
    expect(workState.calls.hiddenAlertIds).toHaveLength(0);
    expect(workState.calls.alertIdsInState).toHaveLength(0);
  });

  it('_all (clientId null): work-state calls pass null client, same as hiddenAlertIds already did', async () => {
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5, 'cA')]);
    const workState = makeWorkStateStub({ alertIdsInState: async () => ['x1'] });
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', null, { userId: 'u1', workStates: ['assigned'] },
    );
    expect(getArgs().where.id).toEqual({ in: ['x1'] });
    expect(workState.calls.alertIdsInState[0]).toEqual(['t1', 'u1', null, ['assigned']]);
  });
});

/**
 * Gate F d (MP-07): facet counts must carry the SAME work-state narrowing as
 * the item query, and a facet must never filter by its own dimension.
 */
describe('FeedService.getFeed — facet counts respect the filter (MP-07)', () => {
  it('sourceType/severity counts are narrowed by the SAME work-state filter as the items', async () => {
    const groups = [{ sourceType: 'bill', _count: 5 }];
    const groupsSev = [{ severity: 'critical', _count: 5 }];
    let sourceTypeWhere: any;
    let severityWhere: any;
    let call = 0;
    const tx = {
      intelAlert: {
        findMany: async (args: any) => [mkRow(1, 0.5)].slice(0, args.take),
        groupBy: async (args: any) => {
          call += 1;
          if (call === 1) sourceTypeWhere = args.where;
          else severityWhere = args.where;
          return args.by[0] === 'sourceType' ? groups : groupsSev;
        },
      },
      watchlistTerm: { findMany: async () => [] },
      transcriptSegment: { findMany: async () => [] },
    };
    const prisma = { ...tx, withTenant: async (_t: string, cb: any) => cb(tx) } as any;
    const workState = makeWorkStateStub({ hiddenAlertIds: async () => ['h1'] });

    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, workState as any).getFeed(
      't1', 'c1', { userId: 'u1', severities: ['critical'] },
    );

    // sourceType facet: carries the work-state exclusion AND the severity filter
    // (severity is not the sourceType facet's own dimension).
    expect(sourceTypeWhere.id).toEqual({ notIn: ['h1'] });
    expect(sourceTypeWhere.severity).toEqual({ in: ['critical'] });

    // severity facet: carries the work-state exclusion but NOT its own severity
    // filter (a facet never filters by its own dimension — d-3).
    expect(severityWhere.id).toEqual({ notIn: ['h1'] });
    expect(severityWhere.severity).toBeUndefined();
  });

  it("Bill 360 event history (sourceRef) scopes facet counts to that bill, not the whole client", async () => {
    let sourceTypeWhere: any;
    const tx = {
      intelAlert: {
        findMany: async (args: any) => [mkRow(1, 0.5)].slice(0, args.take),
        groupBy: async (args: any) => {
          if (args.by[0] === 'sourceType') sourceTypeWhere = args.where;
          return [];
        },
      },
      watchlistTerm: { findMany: async () => [] },
      transcriptSegment: { findMany: async () => [] },
    };
    const prisma = { ...tx, withTenant: async (_t: string, cb: any) => cb(tx) } as any;
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed(
      't1', 'c1', { sourceRef: 'bill-123' },
    );
    // Before MP-07's fix, sourceRef only ever reached `where`, never the
    // facet's `baseWhere` — so this would have been undefined.
    expect(sourceTypeWhere.sourceRef).toBe('bill-123');
  });
});

describe('FeedService.getFeed tenant-wide roll-up (P11)', () => {
  it('drops the clientId predicate when clientId is null (still tenant-scoped)', async () => {
    const { prisma, getArgs } = mockPrisma(
      [mkRow(1, 0.5, 'cA'), mkRow(2, 0.4, 'cB')],
      [{ sourceType: 'bill', _count: 2 }],
    );
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', null, {});
    const w = getArgs().where;
    expect(w.tenantId).toBe('t1');
    expect(w.clientId).toBeUndefined();
    expect(w.status).toEqual({ in: DEFAULT_STATUSES });
  });

  it('keeps the keyset predicate + ordering across clients (no OFFSET)', async () => {
    const cursor = encodeCursor('date', {
      score: 0.5,
      createdAt: new Date('2026-06-24T00:00:00Z'),
      id: 'idX',
    });
    const { prisma, getArgs } = mockPrisma([mkRow(1, 0.5, 'cA')]);
    await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', null, {
      order: 'date',
      cursor,
    });
    const a = getArgs();
    expect(a.where.clientId).toBeUndefined();
    expect(a.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(a.where.OR).toHaveLength(2);
    expect(a.skip).toBeUndefined(); // keyset, never OFFSET
  });

  it('labels each alert with its clientId + resolved clientName', async () => {
    const { prisma } = mockPrisma([mkRow(1, 0.5, 'cA'), mkRow(2, 0.4, 'cB')]);
    const sourceData = {
      getClientNames: async (_t: string, ids: string[]) => {
        expect(ids).toEqual(['cA', 'cB']);
        return new Map([
          ['cA', 'Acme Defense'],
          ['cB', 'Beacon AI'],
        ]);
      },
    } as any;
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, sourceData, NO_WORK_STATE).getFeed('t1', null, {});
    expect((r.items[0] as any).clientId).toBe('cA');
    expect((r.items[0] as any).clientName).toBe('Acme Defense');
    expect((r.items[1] as any).clientName).toBe('Beacon AI');
  });

  it('does not resolve names for the per-client view (clientName null)', async () => {
    const { prisma } = mockPrisma([mkRow(1, 0.5, 'c1')]);
    const sourceData = {
      getClientNames: async () => {
        throw new Error('should not be called for a per-client feed');
      },
    } as any;
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, sourceData, NO_WORK_STATE).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).clientName).toBeNull();
  });
});

describe('FeedService decrypt-on-read', () => {
  const encRow = () => ({
    id: 'a1',
    sourceType: 'hearing',
    kind: 'hearing_mention',
    severity: 'notable',
    materiality: 'medium',
    score: 0.6,
    clientImpact: 'monitor',
    urgency: 'med',
    title: 't',
    whyItMatters: null,
    recommendedAction: null,
    status: 'new',
    createdAt: new Date('2026-06-24T00:00:00Z'),
    evidence: {
      hearing: {
        mentions: [
          { segmentId: 'seg1', quoteSource: 'encrypted', quote: null },
          { segmentId: 'seg2', quoteSource: 'textPlain', quote: 'already here' },
        ],
      },
    },
  });
  function prismaWithSeg(seg: any) {
    const tx = {
      intelAlert: { findMany: async () => [encRow()], groupBy: async () => [] },
      transcriptSegment: { findMany: async () => (seg ? [seg] : []) },
      watchlistTerm: { findMany: async () => [] },
    };
    return { ...tx, withTenant: async (_t: string, cb: any) => cb(tx) } as any;
  }

  it('fills encrypted quotes via HearingCryptoService, leaves textPlain intact', async () => {
    const crypto = { configured: true, decrypt: () => 'DECRYPTED' } as any;
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, crypto, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    const mentions = (r.items[0] as any).evidence.hearing.mentions;
    expect(mentions[0].quote).toBe('DECRYPTED');
    expect(mentions[1].quote).toBe('already here');
  });

  it('fails closed: decrypt error leaves quote null, never leaks ciphertext', async () => {
    const crypto = {
      configured: true,
      decrypt: () => {
        throw new Error('bad key');
      },
    } as any;
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, crypto, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).evidence.hearing.mentions[0].quote).toBeNull();
  });

  it('is a no-op when no key is configured', async () => {
    const prisma = prismaWithSeg({ id: 'seg1', textCiphertext: 'ct', iv: 'iv', authTag: 'tag' });
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).evidence.hearing.mentions[0].quote).toBeNull();
  });
});

/**
 * P0-07 / P1-09 end-to-end through getFeed (Gate C a-8 cases 11-14). The unit-level
 * contract lives in normalize-evidence.spec.ts; these are the wire-level locks.
 */
describe('FeedService.getFeed — normalized evidence (P0-07, P1-09)', () => {
  /** The exact object bill-change-detector.service.ts:1031-1048 stores. */
  const flatBillRow = (over: Record<string, unknown> = {}) => ({
    id: 'a-flat',
    clientId: 'c1',
    sourceType: 'bill',
    sourceRef: '119-hr-8800',
    kind: 'committee_vote',
    severity: 'notable',
    materiality: 'medium',
    score: 0.7,
    clientImpact: 'monitor',
    urgency: 'med',
    title: 'H.R. 8800: Reported by committee',
    whyItMatters: 'Matches your watchlist term "hypersonics".',
    recommendedAction: null,
    status: 'new',
    createdAt: new Date('2026-07-20T00:00:00Z'),
    termId: null,
    evidence: {
      tally: { yea: 32, nay: 12 },
      stage: 'Reported by committee',
      actionText: 'Ordered to be Reported by the Yeas and Nays: 32 - 12.',
      actionDate: '2026-07-18',
      url: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      sourceUrl: 'https://www.congress.gov/bill/119th-congress/house-bill/8800',
      why: 'Matches your watchlist term "hypersonics".',
      matchedTags: ['Hypersonics', 'Defense RDT&E'],
      tone: 'positive',
      band: 'B',
      triggerKey: 'committee_vote',
      billTitle: 'Hypersonic Capability Acceleration Act',
      displayNum: 'H.R. 8800',
      jurisdiction: 'US',
    },
    ...over,
  });

  // Case 11 — the P0-07 regression lock.
  it('returns a nested evidence.bill for a FLAT bill-change-detector row', async () => {
    const { prisma } = mockPrisma([flatBillRow()]);
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    const ev = (r.items[0] as any).evidence;
    expect(ev.bill.displayNum).toBe('H.R. 8800');
    expect(ev.bill.billId).toBe('119-hr-8800');
    expect(ev.bill.title).toBe('Hypersonic Capability Acceleration Act');
    expect(ev.bill.stage).toBe('Reported by committee');
    expect(ev.bill.actionText).toContain('Ordered to be Reported');
    expect(ev.bill.actionDate).toBe('2026-07-18');
    expect(ev.bill.url).toContain('congress.gov');
    expect(ev.schemaVersion).toBe(1);
    expect(ev.type).toBe('bill');
    expect(ev.provenance.writerShape).toBe('flat_bill');
    expect(ev.extra.tally).toEqual({ yea: 32, nay: 12 });
  });

  // Case 12 — P1-09.
  it('derives the tag chip from evidence.matchedTags when there is no termId', async () => {
    const { prisma } = mockPrisma([flatBillRow()]);
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).tag).toBe('Hypersonics');
    expect((r.items[0] as any).evidence.match.matchedTags).toEqual(['Hypersonics', 'Defense RDT&E']);
  });

  // Case 13 — existing precedence is untouched.
  it('still prefers the termId topic label over matchedTags when both exist', async () => {
    const { prisma } = mockPrisma(
      [flatBillRow({ termId: 'term-1' })],
      undefined,
      [{ id: 'term-1', value: 'hypersonic', topic: { label: 'Hypersonic Weapons' } }],
    );
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    expect((r.items[0] as any).tag).toBe('Hypersonic Weapons');
    expect((r.items[0] as any).evidence.match.topicLabel).toBe('Hypersonic Weapons');
  });

  // Case 14 — proves b-4 landed with a-3: sessionId moved into `extra`.
  it('still offers open_hearing after normalization moves a flat sessionId into extra', async () => {
    const { prisma } = mockPrisma([
      flatBillRow({
        id: 'a-hearing',
        sourceType: 'hearing',
        sourceRef: 'sess-9',
        // Flat bill-ish keys on a HEARING alert (§4 edge case 3) — no bill may be
        // synthesized from them, and none of them may be lost.
        evidence: { sessionId: 'sess-9', stage: 'Hearing held', actionText: 'Testimony taken' },
      }),
    ]);
    const r = await new FeedService(prisma, NO_CRYPTO, NO_ACTIONS, NO_SOURCE_DATA, NO_WORK_STATE).getFeed('t1', 'c1', {});
    const item = r.items[0] as any;
    expect(item.evidence.extra.sessionId).toBe('sess-9');
    const openHearing = item.recommendedActions.find((a: any) => a.kind === 'open_hearing');
    expect(openHearing?.target?.sessionId).toBe('sess-9');
    // A hearing sourceType must never get a synthesized bill, even with flat keys.
    expect(item.evidence.bill).toBeUndefined();
  });
});
