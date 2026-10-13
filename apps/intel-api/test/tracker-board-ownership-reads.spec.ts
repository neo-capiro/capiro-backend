import { harness, installHooks, args } from './fixtures/tracker-board-ownership/harness.js';
import {
  tenantId,
  clientId,
  billId,
  stateId,
  now,
  federal,
  state,
  tracked,
  alert,
  cursor,
  deferred,
} from './fixtures/tracker-board-ownership/rows.js';

installHooks();

it('launches page and count in distinct tenant transactions before any enrichment and waits for both', async () => {
  const page = deferred<ReturnType<typeof tracked>[]>(),
    total = deferred<number>();
  const h = harness({
    results: {
      'trackedBill.findMany': page.promise,
      'trackedBill.count': total.promise,
      federalRows: [federal()],
    },
  });
  const pending = h.service.getBoard(tenantId, clientId, { limit: 2 });
  await h.started('trackedBill.count');
  const read = h.callsOf('trackedBill.findMany')[0]!,
    count = h.callsOf('trackedBill.count')[0]!;
  expect(read.transaction).not.toBe(count.transaction);
  expect([read.scope, count.scope]).toEqual(['tenant', 'tenant']);
  expect(args(read)).toEqual({
    where: { tenantId, clientId },
    orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }],
    take: 3,
  });
  expect(args(count)).toEqual({ where: { tenantId, clientId } });
  expect(h.callsOf('federalRows')).toHaveLength(0);
  page.resolve([tracked()]);
  await Promise.resolve();
  expect(h.callsOf('federalRows')).toHaveLength(0);
  total.resolve(7);
  const result = await pending;
  expect(result).toMatchObject({ total: 7, withheld: 6, hasMore: false, nextCursor: null });
  expect(h.callsOf('federalRows')[0]!.args[1]).toEqual([billId]);
});

it('waits for the changed-ID prefilter and uses its bound clock before scoped page/count reads', async () => {
  const changes = deferred<Array<{ sourceRef: string }>>();
  const h = harness({ queues: { 'intelAlert.findMany': [changes.promise, []] } });
  const pending = h.service.getBoard(tenantId, clientId, { filters: { changedWithinDays: 3 } });
  await h.started('intelAlert.findMany');
  expect(h.callsOf('trackedBill.findMany')).toHaveLength(0);
  expect(args(h.callsOf('intelAlert.findMany')[0]!)).toEqual({
    where: {
      tenantId,
      clientId,
      sourceType: { in: ['bill', 'state_bill'] },
      createdAt: { gte: new Date(now.getTime() - 3 * 86400000) },
    },
    select: { sourceRef: true },
    distinct: ['sourceRef'],
  });
  changes.resolve([{ sourceRef: billId }, { sourceRef: billId }]);
  await pending;
  expect(args(h.callsOf('trackedBill.count')[0]!).where).toEqual({
    tenantId,
    clientId,
    billId: { in: [billId] },
  });
});

it.each(['client', 'tenant'] as const)(
  'returns a truthful empty %s board before page queries when changed IDs are empty',
  async (scope) => {
    const h = harness();
    const opts = { filters: { changedWithinDays: 1 } };
    const result =
      scope === 'client'
        ? await h.service.getBoard(tenantId, clientId, opts)
        : await h.service.getTenantBoard(tenantId, opts);
    expect(result).toMatchObject({ nextCursor: null, hasMore: false, total: 0, withheld: 0 });
    expect(result.columns.every((column) => column.cards.length === 0)).toBe(true);
    expect(h.callsOf('trackedBill.findMany')).toHaveLength(0);
    expect(h.callsOf('trackedBill.count')).toHaveLength(0);
  },
);

it('keeps legacy two-key tenant cursor continuation without synthesizing a client tiebreaker', async () => {
  const h = harness();
  await h.service.getTenantBoard(tenantId, {
    cursor: cursor({ t: now.toISOString(), id: billId }),
    filters: { clientIds: [clientId] },
  });
  expect(args(h.callsOf('trackedBill.findMany')[0]!)).toEqual({
    where: {
      tenantId,
      clientId: { in: [clientId] },
      OR: [{ trackedAt: { lt: now } }, { trackedAt: now, billId: { lt: billId } }],
    },
    orderBy: [{ trackedAt: 'desc' }, { billId: 'desc' }, { clientId: 'desc' }],
    take: 201,
  });
  expect(args(h.callsOf('trackedBill.count')[0]!).where).toEqual({
    tenantId,
    clientId: { in: [clientId] },
  });
});

it('preserves an accepted cursor invalid-date value for the query boundary instead of silently fixing it', async () => {
  const h = harness();
  await h.service.getBoard(tenantId, clientId, {
    cursor: cursor({ t: 'not-a-date', id: billId }),
    limit: 999,
  });
  const where = args(h.callsOf('trackedBill.findMany')[0]!).where as {
    OR: Array<{ trackedAt: Date | { lt: Date } }>;
  };
  expect((where.OR[0]!.trackedAt as { lt: Date }).lt.getTime()).toBeNaN();
  expect((where.OR[1]!.trackedAt as Date).getTime()).toBeNaN();
  expect(args(h.callsOf('trackedBill.findMany')[0]!).take).toBe(501);
});

it('preserves the exact corrected-state AND predicate and candidate-read scope before pagination', async () => {
  const unknown = 'ca-2025-zz9999';
  const h = harness({
    queues: {
      'trackedBill.findMany': [[{ billId }, { billId: stateId }, { billId: unknown }], []],
    },
    results: { stateRows: [state({ status: 'failed' })] },
  });
  await h.service.getBoard(tenantId, clientId, { filters: { activeOnly: true } });
  expect(args(h.callsOf('trackedBill.findMany')[0]!)).toEqual({
    where: { tenantId, clientId },
    select: { billId: true },
    distinct: ['billId'],
  });
  expect(h.callsOf('stateRows')[0]!.args[1]).toEqual([stateId, unknown]);
  const expected = {
    tenantId,
    clientId,
    AND: [
      {
        OR: [
          { AND: [{ billId: { notIn: [stateId] } }, { stage: { not: 'enacted' } }] },
          { billId: { in: [] } },
        ],
      },
    ],
  };
  expect(args(h.callsOf('trackedBill.findMany')[1]!).where).toEqual(expected);
  expect(args(h.callsOf('trackedBill.count')[0]!).where).toEqual(expected);
  expect(h.callsOf('stateRows')[0]!.scope).toBe('global');
});

it('starts the client source/compile/alert/hearing bundle together and retains selected severity without evidence', async () => {
  const source = deferred<ReturnType<typeof federal>[]>();
  const row = tracked();
  const h = harness({
    results: {
      'trackedBill.findMany': [row],
      'trackedBill.count': 1,
      federalRows: source.promise,
      'intelAlert.findMany': [alert()],
      'intelAlert.groupBy': [{ sourceRef: billId, _count: { _all: 4 } }],
    },
  });
  const pending = h.service.getBoard(tenantId, clientId);
  await h.started('intelAlert.groupBy');
  expect(h.callsOf('watchlist.findFirst')).toHaveLength(1);
  expect(h.callsOf('federalRows')).toHaveLength(1);
  expect(args(h.callsOf('intelAlert.findMany')[0]!).select).toEqual({
    sourceRef: true,
    changeType: true,
    title: true,
    createdAt: true,
    severity: true,
  });
  expect(args(h.callsOf('intelAlert.groupBy')[0]!)).toEqual({
    by: ['sourceRef'],
    where: {
      tenantId,
      clientId,
      sourceType: 'combined',
      sourceRef: { in: [billId] },
      status: { notIn: ['dismissed', 'snoozed', 'suppressed'] },
    },
    _count: { _all: true },
  });
  source.resolve([federal()]);
  const card = (await pending).columns.flatMap((column) => column.cards)[0]!;
  expect(card.trackedAt).toBe(row.trackedAt);
  expect(card.changeChip).toMatchObject({ at: now, severity: 'critical', tone: 'success' });
  expect(card.hearingCount).toBe(4);
});

it('waits for the whole tenant enrichment bundle before batched compilation and only client names degrade', async () => {
  const names = deferred<unknown[]>();
  const h = harness({
    results: {
      'trackedBill.findMany': [tracked()],
      'trackedBill.count': 1,
      federalRows: [federal()],
      clientNames: names.promise,
    },
  });
  const pending = h.service.getTenantBoard(tenantId);
  await h.started('clientNames');
  expect(h.callsOf('watchlist.findMany')).toHaveLength(0);
  expect(h.callsOf('watchlistTopic.findMany')).toHaveLength(0);
  expect(h.callsOf('intelAlert.groupBy')).toHaveLength(1);
  names.reject(new Error('names unavailable'));
  const card = (await pending).columns.flatMap((column) => column.cards)[0]!;
  expect(card.clientName).toBeNull();
  expect(card.matchedTags).toContain('Grid');
  expect(h.callsOf('watchlist.findMany')[0]!.transaction).toBe(
    h.callsOf('watchlistTopic.findMany')[0]!.transaction,
  );
  expect(h.callsOf('watchlistTerm.findMany')[0]!.transaction).not.toBe(
    h.callsOf('watchlistTopic.findMany')[0]!.transaction,
  );
});

it.each([
  'trackedBill.count',
  'intelAlert.findMany',
  'intelAlert.groupBy',
  'federalRows',
  'watchlistTerm.findMany',
])('preserves fatal %s read errors without returning a partial board', async (operation) => {
  const failure = new Error(operation);
  const h = harness({
    results: {
      'trackedBill.findMany': [tracked()],
      'trackedBill.count': 1,
      federalRows: [federal()],
      [operation]: failure,
    },
  });
  await expect(h.service.getBoard(tenantId, clientId)).rejects.toBe(failure);
});
