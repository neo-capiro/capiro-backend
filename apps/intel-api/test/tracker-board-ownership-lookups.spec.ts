import { harness, installHooks, args } from './fixtures/tracker-board-ownership/harness.js';
import {
  tenantId,
  clientId,
  userId,
  billId,
  federal,
  state,
  watchlist,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('validates a supplied alert after client ownership and preserves the exact feedback input arrays and raw reference', async () => {
  const tags = ['Grid'],
    ids = ['topic-grid'];
  const h = harness();
  expect(
    await h.service.recordFeedback(tenantId, clientId, userId, {
      targetType: 'regulation',
      targetRef: ' document ',
      signal: 'memo_generated',
      alertId: 'alert-1',
      reason: 'too_broad',
      matchedTags: tags,
      matchedTopicIds: ids,
    }),
  ).toEqual({ ok: true });
  expect(args(h.callsOf('intelAlert.findFirst')[0]!)).toEqual({
    where: { id: 'alert-1', tenantId, clientId },
    select: { id: true },
  });
  const data = args(h.callsOf('intelFeedback.create')[0]!).data as {
    matchedTags: string[];
    matchedTopicIds: string[];
  };
  expect(data).toEqual({
    tenantId,
    clientId,
    userId,
    targetType: 'regulation',
    targetRef: ' document ',
    signal: 'memo_generated',
    alertId: 'alert-1',
    reason: 'too_broad',
    matchedTags: tags,
    matchedTopicIds: ids,
  });
  expect(data.matchedTags).toBe(tags);
  expect(data.matchedTopicIds).toBe(ids);
  expect(h.events.indexOf('clientOwnership')).toBeLessThan(
    h.events.indexOf('intelAlert.findFirst'),
  );
  expect(h.events.indexOf('intelAlert.findFirst')).toBeLessThan(
    h.events.indexOf('intelFeedback.create'),
  );
});

it.each([
  { targetRef: '', signal: 'invalid', message: 'Unknown feedback signal "invalid"' },
  { targetRef: '   ', signal: 'opened', message: 'targetRef is required' },
])(
  'keeps allowlist and targetRef validation ahead of optional alert authority for %j',
  async ({ targetRef, signal, message }) => {
    const h = harness();
    await expect(
      h.service.recordFeedback(tenantId, clientId, userId, {
        targetRef,
        signal,
        alertId: 'foreign',
      }),
    ).rejects.toThrow(message);
    expect(h.callsOf('clientOwnership')).toHaveLength(1);
    expect(h.callsOf('intelAlert.findFirst')).toHaveLength(0);
    expect(h.callsOf('intelFeedback.create')).toHaveLength(0);
  },
);

it('fails closed on a missing alert without committing feedback', async () => {
  const h = harness({ results: { 'intelAlert.findFirst': null } });
  await expect(
    h.service.recordFeedback(tenantId, clientId, userId, {
      targetRef: billId,
      signal: 'opened',
      alertId: 'foreign',
    }),
  ).rejects.toThrow('Alert not found');
  expect(h.callsOf('intelFeedback.create')).toHaveLength(0);
});

it.each(['opened', 'outreach_generated', 'alert_ignored'])(
  'accepts original %s service learning signals with exact defaults and no alert lookup',
  async (signal) => {
    const h = harness();
    await h.service.recordFeedback(tenantId, clientId, userId, { targetRef: billId, signal });
    expect(args(h.callsOf('intelFeedback.create')[0]!)).toEqual({
      data: {
        tenantId,
        clientId,
        userId,
        alertId: null,
        targetType: 'bill',
        targetRef: billId,
        signal,
        reason: null,
        matchedTags: [],
        matchedTopicIds: [],
      },
    });
    expect(h.callsOf('intelAlert.findFirst')).toHaveLength(0);
  },
);

it('preserves duplicate historical feedback keys and unspecified reasons without rematching renamed labels', async () => {
  const h = harness({
    results: {
      'intelFeedback.findMany': [
        {
          matchedTags: ['Old label'],
          matchedTopicIds: ['topic-grid', 'topic-grid'],
          reason: 'wrong_issue',
        },
        { matchedTags: ['Old label', 'Old label'], matchedTopicIds: [], reason: null },
      ],
    },
  });
  const result = await h.service.feedbackSignal(tenantId, clientId);
  expect([...result]).toEqual([
    ['topic-grid', { total: 2, byReason: { wrong_issue: 2 } }],
    ['Old label', { total: 2, byReason: { unspecified: 2 } }],
  ]);
  expect(args(h.callsOf('intelFeedback.findMany')[0]!)).toEqual({
    where: { tenantId, clientId, signal: 'marked_irrelevant', matchedTags: { isEmpty: false } },
    select: { matchedTags: true, matchedTopicIds: true, reason: true },
  });
  expect(h.callsOf('watchlist.findFirst')).toHaveLength(0);
});

it('launches summary reads in independent transactions and awaits both original payloads', async () => {
  const rows = deferred<Array<{ unread: boolean }>>(),
    wl = deferred<ReturnType<typeof watchlist> | null>();
  const h = harness({
    results: { 'trackedBill.findMany': rows.promise, 'watchlist.findFirst': wl.promise },
  });
  const pending = h.service.getSummary(tenantId, clientId);
  await h.started('watchlist.findFirst');
  expect(h.callsOf('trackedBill.findMany')[0]!.transaction).not.toBe(
    h.callsOf('watchlist.findFirst')[0]!.transaction,
  );
  expect(args(h.callsOf('trackedBill.findMany')[0]!)).toEqual({
    where: { tenantId, clientId },
    select: { unread: true },
  });
  expect(args(h.callsOf('watchlist.findFirst')[0]!)).toEqual({
    where: { tenantId, clientId },
    select: { issueAreas: true, _count: { select: { topics: true } } },
  });
  rows.resolve([{ unread: true }, { unread: false }]);
  wl.resolve(null);
  expect(await pending).toEqual({ boardCount: 2, unread: 1, hasWatchlist: false });
});

it('returns direct tracked status and per-client group counts without board hydration or compilation', async () => {
  const time = new Date('2026-08-01T00:00:00Z');
  const h = harness({
    results: {
      'trackedBill.findFirst': { id: 'row', trackedAt: time },
      'trackedBill.groupBy': [{ clientId, _count: { _all: 8 } }],
    },
  });
  const status = await h.service.getTrackedStatus(tenantId, clientId, billId);
  expect(status).toEqual({ tracked: true, trackedAt: time });
  expect(status.trackedAt).toBe(time);
  expect(await h.service.getPortfolioCounts(tenantId)).toEqual({ counts: { [clientId]: 8 } });
  expect(args(h.callsOf('trackedBill.findFirst')[0]!)).toEqual({
    where: { tenantId, clientId, billId },
    select: { id: true, trackedAt: true },
  });
  expect(args(h.callsOf('trackedBill.groupBy')[0]!)).toEqual({
    by: ['clientId'],
    where: { tenantId },
    _count: { _all: true },
  });
  expect(h.callsOf('federalRows')).toHaveLength(0);
});

it('launches global search rails eagerly, binds full-corpus SQL and applies one federal-first local cap', async () => {
  const federalRows = deferred<ReturnType<typeof federal>[]>(),
    stateRows = deferred<ReturnType<typeof state>[]>();
  const h = harness({
    results: { federalSearch: federalRows.promise, stateSearch: stateRows.promise },
  });
  const pending = h.service.searchBills(' H.R. 7 ', { limit: 1 });
  await h.started('stateSearch');
  expect(h.callsOf('federalSearch')[0]!.scope).toBe('global');
  expect(h.callsOf('stateSearch')[0]!.scope).toBe('global');
  expect(h.callsOf('federalSearch')[0]!.args.slice(1)).toEqual(['%h.r. 7%', '%hr-7%', null]);
  expect(h.callsOf('federalSearch')[0]!.args[0]).toContain('LIMIT 20');
  expect(h.callsOf('stateSearch')[0]!.args.slice(1)).toEqual(['%h.r. 7%', '%hr-7%', [], 1]);
  stateRows.resolve([state()]);
  federalRows.resolve([federal()]);
  expect((await pending).map((row) => row.billId)).toEqual([billId]);
  expect(h.calls.some((call) => call.scope === 'tenant')).toBe(false);
});

it('preserves normalized duplicated state search facets and clamps the bound state/local limit to fifty', async () => {
  const h = harness();
  await h.service.searchBills('density', { jurisdictions: [' ca ', '', 'CA'], limit: 999 });
  expect(h.callsOf('federalSearch')).toHaveLength(0);
  expect(h.callsOf('stateSearch')[0]!.args.slice(1)).toEqual([
    '%density%',
    '%density%',
    ['CA', 'CA'],
    50,
  ]);
});

it.each(['federalSearch', 'stateSearch', 'trackedBill.findFirst', 'trackedBill.groupBy'])(
  'keeps %s auxiliary I/O failure fatal',
  async (operation) => {
    const failure = new Error(operation),
      h = harness({ results: { [operation]: failure } });
    const pending = operation.endsWith('Search')
      ? h.service.searchBills('grid')
      : operation.endsWith('findFirst')
        ? h.service.getTrackedStatus(tenantId, clientId, billId)
        : h.service.getPortfolioCounts(tenantId);
    await expect(pending).rejects.toBe(failure);
  },
);
