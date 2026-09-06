import { LegiWatchAnalyticsService } from './legiwatch-analytics.service.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as never;

describe('LegiWatch analytics correctness', () => {
  function setup(rows: unknown[]) {
    const tx = { $queryRaw: jest.fn().mockResolvedValue(rows), committeeSource: { count: jest.fn().mockResolvedValue(0) } };
    const prisma = { withTenant: jest.fn((_tenant: string, run: (db: typeof tx) => unknown) => run(tx)) };
    return { service: new LegiWatchAnalyticsService(prisma as never), tx, prisma };
  }

  it('reports a steady daily rate as 100 when SQL returns disjoint prior/recent buckets', async () => {
    const { service } = setup([
      { topicId: 'steady', label: 'Steady topic', window: 'trail30', weighted: 23 },
      { topicId: 'steady', label: 'Steady topic', window: 'recent7', weighted: 7 },
    ]);
    const result = await service.issueMomentum(ctx, 'client-a');
    expect(result.topics).toEqual([{ topicId: 'steady', label: 'Steady topic', index: 100 }]);
  });

  it('keeps a real growing topic even when its recent week exceeds prior history', async () => {
    const { service } = setup([
      { topicId: 'growing', label: 'Growing topic', window: 'trail30', weighted: 23 },
      { topicId: 'growing', label: 'Growing topic', window: 'recent7', weighted: 28 },
      { topicId: 'new', label: 'New topic', window: 'recent7', weighted: 7 },
    ]);
    const result = await service.issueMomentum(ctx, null);
    expect(result.topics).toEqual([{ topicId: 'growing', label: 'Growing topic', index: 400 }]);
  });

  it.each(['client-a', null])('uses the canonical tracked corpus within scope %s', async (clientId) => {
    const { service, tx, prisma } = setup([]);
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ tracked: 3n, moved: 2n }]);
    const result = await service.summary(ctx, clientId, '2026-08-01', '2026-09-01');
    expect(result).toMatchObject({ billsTrackedTotal: 3, billsMoved: 2 });
    expect((tx.$queryRaw.mock.calls[0]![0] as TemplateStringsArray).join('?')).toContain("status IN ('new', 'reviewed', 'sent')");
    const [sql, ...bindings] = tx.$queryRaw.mock.calls[1]!;
    const text = (sql as TemplateStringsArray).join('?');
    expect(text).toContain('SELECT DISTINCT bill_id FROM intel_tracked_bill');
    expect(text).toContain('WHERE tenant_id = ?');
    expect(text).toContain('client_id = ?');
    expect(text).toContain('LEFT JOIN state_bill');
    expect(bindings.slice(0, 3)).toEqual(['tenant-a', clientId, clientId]);
    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
  });

  it('includes state, regulation and funding signals in the exposure matrix', async () => {
    const { service, tx } = setup([]);
    Object.assign(tx, { client: { findMany: jest.fn().mockResolvedValue([{ id: 'client-a', name: 'Alpha' }]) } });
    tx.$queryRaw.mockResolvedValueOnce([{ clientId: 'client-a' }]).mockResolvedValueOnce([
      { clientId: 'client-a', sourceType: 'state_bill', count: 2n },
      { clientId: 'client-a', sourceType: 'regulation', count: 3n },
      { clientId: 'client-a', sourceType: 'program_element', count: 4n },
    ]);
    const result = await service.clientExposure(ctx);
    expect(result.rows[0]?.bySourceFamily).toMatchObject({
      'State legislatures': 2, 'Federal Register': 3, 'Program element service': 4,
    });
  });

  it.each([['invalid', '2026-09-01'], ['2026-09-02', '2026-09-01']])('rejects invalid dates before querying', async (from, to) => {
    const { service, prisma } = setup([]);
    await expect(service.summary(ctx, null, from, to)).rejects.toThrow('valid dates');
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });
});
