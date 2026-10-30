import { PortfolioMetricsService } from './portfolio-metrics.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const ctx = { tenantId } as never;

type Row = Record<string, unknown>;

/**
 * Minimal transactional client: each model read is supplied by the test, so the
 * service's own arithmetic and its unavailable-on-failure rule are what is
 * being asserted.
 */
function serviceWith(
  reads: Partial<{
    clients: Row[];
    objectives: Row[];
    activity: Record<string, number>;
    watches: Row[];
  }>,
  options: { fail?: 'clients' | 'objectives' | 'activity' | 'billWatch' } = {},
) {
  const fail = options.fail;
  const tx = {
    client: {
      count: async ({ where }: { where: { status?: string } }) => {
        if (fail === 'clients') throw new Error('clients read failed');
        return where.status === 'active'
          ? (reads.clients ?? []).length
          : (reads.clients ?? []).length;
      },
      findMany: async () => {
        if (fail === 'billWatch') throw new Error('watches read failed');
        return (reads.clients ?? []).map((client) => ({ id: client.id }));
      },
    },
    clientObjective: {
      findMany: async () => {
        if (fail === 'objectives') throw new Error('objectives read failed');
        return reads.objectives ?? [];
      },
    },
    clientActivity: {
      count: async ({ where }: { where: { kind?: string } }) => {
        if (fail === 'activity') throw new Error('activity read failed');
        return reads.activity?.[where.kind ?? 'all'] ?? 0;
      },
    },
    trackedBill: {
      findMany: async () => {
        if (fail === 'billWatch') throw new Error('watches read failed');
        return reads.watches ?? [];
      },
    },
  };
  const prisma = {
    withTenant: async (_tenant: string, fn: (tx: unknown) => Promise<unknown>) =>
      fn(tx),
  };
  return new PortfolioMetricsService(prisma as never);
}

const client = (id: string) => ({ id });

/** Narrow one group to its counts; a status other than available fails loudly. */
function countsOf<T>(group: {
  status: 'available' | 'unavailable';
  coverage?: 'complete';
  counts?: T;
}): T {
  if (group.status !== 'available' || group.counts === undefined)
    throw new Error('expected an available group');
  return group.counts;
}

describe('portfolio metrics', () => {
  test('returns the recorded-baseline contract with a 30-day window ending at observedAt', async () => {
    const result = await serviceWith({
      clients: [client('a'), client('b')],
      objectives: [{ status: 'draft' }, { status: 'in_review' }, { status: 'ready' }],
      activity: { all: 4, request: 2, commitment: 1 },
      watches: [
        { clientId: 'a', billId: '119-hr-1' },
        { clientId: 'a', billId: '119-hr-2' },
        { clientId: 'b', billId: '119-hr-1' },
      ],
    }).getMetrics(ctx);

    expect(result.definition).toBe('portfolio-recorded-baseline-v1');
    expect(result.tenantId).toBe(tenantId);
    expect(result.activityWindow.timezone).toBe('UTC');
    expect(result.activityWindow.end).toBe(result.observedAt);
    expect(
      Date.parse(result.activityWindow.end) -
        Date.parse(result.activityWindow.start),
    ).toBe(30 * 86400000);

    expect(result.clients).toEqual({
      status: 'available',
      coverage: 'complete',
      counts: { activeClients: 2 },
    });
    // Only the states that exist count in their bucket; `draft` is neither
    // awaiting review nor ready, but it is still an objective.
    expect(countsOf(result.objectives)).toEqual({
      objectives: 3,
      awaitingReview: 1,
      ready: 1,
    });
    expect(countsOf(result.activity)).toEqual({
      recordedActivities: 4,
      overdueRequests: 2,
      overdueCommitments: 1,
    });
    expect(countsOf(result.billWatch)).toEqual({
      activeClients: 2,
      clientsWithWatches: 2,
      clientBillWatches: 3,
      distinctBills: 2,
    });
  });

  test('scopes every read to the calling tenant', async () => {
    const seen: string[] = [];
    const prisma = {
      withTenant: async (tenant: string, fn: (tx: unknown) => Promise<unknown>) => {
        seen.push(tenant);
        return fn({
          client: { count: async () => 0, findMany: async () => [] },
          clientObjective: { findMany: async () => [] },
          clientActivity: { count: async () => 0 },
          trackedBill: { findMany: async () => [] },
        });
      },
    };
    await new PortfolioMetricsService(prisma as never).getMetrics(ctx);
    expect(seen).toEqual([tenantId]);
  });

  test.each(['clients', 'objectives', 'activity', 'billWatch'] as const)(
    'degrades only the %s group when that read fails',
    async (group) => {
      const result = await serviceWith(
        {
          clients: [client('a')],
          objectives: [{ status: 'ready' }],
          activity: { all: 1 },
          watches: [{ clientId: 'a', billId: '119-hr-1' }],
        },
        { fail: group },
      ).getMetrics(ctx);

      expect(result[group]).toEqual({ status: 'unavailable' });
      for (const other of ['clients', 'objectives', 'activity', 'billWatch'] as const)
        if (other !== group) expect(result[other].status).toBe('available');
    },
  );

  test('an empty portfolio reports zero coverage rather than inventing a percentage', async () => {
    const result = await serviceWith({}).getMetrics(ctx);
    expect(countsOf(result.billWatch)).toEqual({
      activeClients: 0,
      clientsWithWatches: 0,
      clientBillWatches: 0,
      distinctBills: 0,
    });
  });
});
