jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class PrismaService {} }), {
  virtual: true,
});

import { PublicBillReadService } from './public-bill-read.service.js';
import type { RetrievalRequest } from '../retrieval-v2.types.js';

function setup() {
  const stamp = new Date('2026-09-06T12:00:00Z');
  const congressBill = {
    findMany: jest.fn().mockResolvedValue([
      {
        id: '119-hr-1',
        title: 'Bill',
        status: 'committee',
        latestActionDate: stamp,
        updateDate: stamp,
        lastSyncedAt: stamp,
        url: 'https://congress.gov/bill/119/house-bill/1',
      },
    ]),
    count: jest.fn().mockResolvedValue(3),
    aggregate: jest.fn().mockResolvedValue({ _max: { lastSyncedAt: stamp } }),
  };
  const stateBill = {
    findMany: jest.fn().mockResolvedValue([
      {
        id: 'FL-2026-HB1',
        title: 'State bill',
        status: 'introduced',
        latestActionDate: stamp,
        syncedAt: stamp,
        stateUrl: 'https://example.gov/HB1',
        url: null,
      },
    ]),
    count: jest.fn().mockResolvedValue(1),
    aggregate: jest.fn().mockResolvedValue({ _max: { syncedAt: stamp } }),
  };
  const prisma = {
    withSystem: jest.fn((fn) => fn({ congressBill, stateBill })),
  };
  const service = new PublicBillReadService(prisma as never);
  const request: RetrievalRequest = {
    queryClass: 'lookup',
    requestedDomains: ['legiwatch_bills'],
    caller: { tenantId: 'tenant', userId: 'user' },
    query: 'robotics',
    windowStart: new Date('2026-09-01T00:00:00Z'),
    windowEnd: stamp,
  };
  return { service, congressBill, stateBill, prisma, request, stamp };
}

describe('public bill read projection', () => {
  it.each([0, 1] as const)(
    'uses deterministic paging and both latest-action date bounds for family %s',
    async (family) => {
      const { service, congressBill, stateBill, request } = setup();
      const result = await service.readPage(family, request, 2, 2);
      const read = family === 0 ? congressBill : stateBill;
      expect(read.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { id: 'asc' },
          skip: 2,
          take: 2,
          where: expect.objectContaining({
            latestActionDate: {
              gte: request.windowStart,
              lte: request.windowEnd,
            },
          }),
        }),
      );
      expect(read.count).toHaveBeenCalledWith({
        where: read.findMany.mock.calls[0][0].where,
      });
      expect(result.records[0]?.payload.status).toBe(family === 0 ? 'committee' : 'introduced');
      expect(result.records[0]?.provenance?.dateFilterBasis).toBe('latestActionDate');
      expect(result.lastSyncAt).toEqual(request.windowEnd);
    },
  );

  it('preserves official state URL and distinguishes scalar summaries from complete histories', async () => {
    const { service, request } = setup();
    const result = await service.readPage(1, request, 1, 10);
    expect(result.records[0]?.provenance).toMatchObject({
      sourceType: 'state_bill',
      sourceUrl: 'https://example.gov/HB1',
      content: 'current_bill_summary',
    });
    expect(result.records[0]?.recordId).toBe('state:FL-2026-HB1');
  });

  it('does not convert a failed public source into an empty successful result', async () => {
    const { service, congressBill, request } = setup();
    congressBill.findMany.mockRejectedValue(new Error('database timeout'));
    await expect(service.readPage(0, request, 1, 10)).rejects.toThrow('database timeout');
  });
});
