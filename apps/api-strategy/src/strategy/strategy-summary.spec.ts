import { describe, expect, it, jest } from '@jest/globals';
import { StrategyService } from './strategy.service.js';

describe('Strategy library assignment summaries', () => {
  it('counts live assignments and review states, excluding completed work from the unassigned action queue', async () => {
    const findMany = jest.fn(async () => [
      {
        id: 's',
        _count: { nodes: 4 },
        nodes: [
          { status: 'active', ownerUserId: 'u' },
          { status: 'draft', ownerUserId: null },
          { status: 'internal_review', ownerUserId: null },
          { status: 'completed', ownerUserId: null },
        ],
      },
    ]);
    const service = new StrategyService(
      {
        withTenant: async (_tenant: string, fn: Function) => fn({ spStrategy: { findMany } }),
      } as never,
      {} as never,
    );
    expect(await service.list('t')).toEqual([
      expect.objectContaining({
        nodeCount: 4,
        summary: { assignedCount: 1, unassignedCount: 2, completedCount: 1, reviewCount: 2 },
      }),
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { archivedAt: null },
        select: expect.objectContaining({
          nodes: expect.objectContaining({ where: { archivedAt: null } }),
        }),
      }),
    );
  });
});
