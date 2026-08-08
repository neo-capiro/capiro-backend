import type { PrismaService } from '../prisma/prisma.service.js';
import { FederalMarketGeographyService } from './federal-market-geography.service.js';
import type { FederalMarketService } from './federal-market.service.js';

function baseResponse() {
  return {
    districts: [
      {
        districtKey: 'VA-10',
        state: 'VA',
        district: '10',
        contractCount: 2,
        contractAmount: 1_200_000,
        subawardCount: 1,
        subawardAmount: 250_000,
      },
      {
        districtKey: 'VA-90',
        state: 'VA',
        district: '90',
        contractCount: 1,
        contractAmount: 50_000,
        subawardCount: 0,
        subawardAmount: null,
      },
    ],
    futureSignals: [],
    awardedMoneyIncludesFutureOpportunities: false as const,
    warnings: [],
    generatedAt: '2026-08-08T00:00:00.000Z',
  };
}

describe('FederalMarketGeographyService', () => {
  it('keeps source-state subawards separate and removes non-district sentinels', async () => {
    const market = { geography: jest.fn().mockResolvedValue(baseResponse()) };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        { state: 'VA', count: 3n, amount: 100_000 },
        { state: 'TX', count: 1n, amount: null },
      ]),
      withTenant: jest.fn(),
    };
    const service = new FederalMarketGeographyService(
      prisma as unknown as PrismaService,
      market as unknown as FederalMarketService,
    );

    const result = await service.geography('tenant-1', { state: 'VA' });

    expect(result.districts.map((row) => row.districtKey)).toEqual(['VA-10']);
    expect(result.stateSubawards).toEqual([
      {
        state: 'VA',
        subawardCount: 3,
        subawardAmount: 100_000,
        geographyBasis: 'source_state_place_of_performance',
      },
      {
        state: 'TX',
        subawardCount: 1,
        subawardAmount: null,
        geographyBasis: 'source_state_place_of_performance',
      },
    ]);
    expect(result.awardedMoneyIncludesFutureOpportunities).toBe(false);
  });

  it('retains the base district/future response when the state-only rail fails', async () => {
    const market = { geography: jest.fn().mockResolvedValue(baseResponse()) };
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('table unavailable')),
      withTenant: jest.fn(),
    };
    const service = new FederalMarketGeographyService(
      prisma as unknown as PrismaService,
      market as unknown as FederalMarketService,
    );

    const result = await service.geography('tenant-1', {});

    expect(result.districts.map((row) => row.districtKey)).toEqual(['VA-10']);
    expect(result.stateSubawards).toEqual([]);
    expect(result.warnings).toContain('state-level subaward geography unavailable');
  });

  it('resolves client identities inside the tenant before querying state-level subawards', async () => {
    const market = { geography: jest.fn().mockResolvedValue(baseResponse()) };
    const tx = {
      client: {
        findFirst: jest.fn().mockResolvedValue({ id: 'client-1', uei: 'AAA111BBB222' }),
      },
      clientIntelMapping: {
        findMany: jest.fn().mockResolvedValue([
          {
            externalId: 'CCC333DDD444',
            externalName: 'Reviewed Affiliate LLC',
          },
        ]),
      },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      withTenant: jest.fn(async (_tenantId: string, run: (value: typeof tx) => unknown) => run(tx)),
    };
    const service = new FederalMarketGeographyService(
      prisma as unknown as PrismaService,
      market as unknown as FederalMarketService,
    );

    await service.geography('tenant-1', { clientId: 'client-1', state: 'VA' });

    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(tx.client.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'client-1' }) }),
    );
    expect(tx.clientIntelMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientId: 'client-1',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
        }),
      }),
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
