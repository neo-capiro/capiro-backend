import type { PrismaService } from '../prisma/prisma.service.js';
import { FederalMarketService } from './federal-market.service.js';

describe('Federal Market legacy global award compatibility owner', () => {
  it('preserves PE and keyword filters, complete raw fields and global access on page two', async () => {
    const row = { id: 'award-1', peCode: '0604201A', recipientState: 'VA' };
    const federalAward = {
      findMany: jest.fn().mockResolvedValue([row]),
      count: jest.fn().mockResolvedValue(57),
    };
    const prisma = {
      withSystem: jest.fn(async (read) => read({ federalAward })),
      withTenant: jest.fn(),
      $queryRaw: jest.fn(),
    };
    const service = new FederalMarketService(prisma as unknown as PrismaService);
    const result = await service.listLegacyGlobalContracts({
      q: 'radar',
      agency: 'Army',
      peCode: '0604201a',
      page: 2,
      pageSize: 20,
    });
    const where = {
      OR: [
        { description: { contains: 'radar', mode: 'insensitive' } },
        { contractorName: { contains: 'radar', mode: 'insensitive' } },
        { awardingAgency: { contains: 'radar', mode: 'insensitive' } },
      ],
      awardingAgency: { contains: 'Army', mode: 'insensitive' },
      peCode: '0604201A',
    };
    expect(federalAward.findMany).toHaveBeenCalledWith({
      where,
      orderBy: [{ actionDate: 'desc' }, { id: 'desc' }],
      take: 20,
      skip: 20,
    });
    expect(federalAward.count).toHaveBeenCalledWith({ where });
    expect(result).toEqual({ data: [row], total: 57, page: 2, pageSize: 20 });
    expect(prisma.withSystem).toHaveBeenCalledTimes(2);
    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each([2026, 0, NaN])(
    'rejects unsupported vehicle fiscalYear %p before any database read',
    async (fiscalYear) => {
      const prisma = { withTenant: jest.fn(), $queryRaw: jest.fn() };
      const service = new FederalMarketService(prisma as unknown as PrismaService);
      await expect(
        service.listVehicles('tenant-1', { clientId: 'client-1', fiscalYear }),
      ).rejects.toThrow('fiscalYear is not supported for contract vehicles');
      expect(prisma.withTenant).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );
});
