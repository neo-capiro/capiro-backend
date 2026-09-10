import { TrackerBoardService } from '../src/tracker/tracker-board.service.js';
import { TrackerBoardController } from '../src/tracker/tracker-board.controller.js';

describe('Portfolio tracked-bill counts (Q12)', () => {
  const groupBy = jest.fn();
  const withTenant = jest.fn((_tenant, fn) => fn({ trackedBill: { groupBy } }));
  const service = new TrackerBoardService({ withTenant } as any, {} as any, {} as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('returns unpaginated totals per client with explicit tenant scoping', async () => {
    groupBy.mockResolvedValue([
      { clientId: 'l3', _count: { _all: 3 } },
      { clientId: 'other', _count: { _all: 301 } },
    ]);
    const controller = new TrackerBoardController(service);
    expect(await controller.getPortfolioCounts({ tenantId: 'tenant-a' } as any)).toEqual({
      counts: { l3: 3, other: 301 },
    });
    expect(withTenant).toHaveBeenCalledWith('tenant-a', expect.any(Function));
    expect(groupBy).toHaveBeenCalledWith({
      by: ['clientId'],
      where: { tenantId: 'tenant-a' },
      _count: { _all: true },
    });
  });

  it('distinguishes a successful empty tracker from a failed read', async () => {
    groupBy.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('database unavailable'));
    expect(await service.getPortfolioCounts('tenant-a')).toEqual({ counts: {} });
    await expect(service.getPortfolioCounts('tenant-a')).rejects.toThrow('database unavailable');
  });
});
