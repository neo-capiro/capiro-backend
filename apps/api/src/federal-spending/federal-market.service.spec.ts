import type { PrismaService } from '../prisma/prisma.service.js';
import { FederalMarketService } from './federal-market.service.js';

type Internals = {
  clientScope: jest.Mock;
  aggregateContractGeography: jest.Mock;
  aggregateSubawardGeography: jest.Mock;
  futureSignals: jest.Mock;
};

function harness() {
  const service = new FederalMarketService({} as PrismaService);
  const internal = service as unknown as Internals;
  internal.clientScope = jest.fn().mockResolvedValue(null);
  internal.aggregateContractGeography = jest.fn().mockResolvedValue([]);
  internal.aggregateSubawardGeography = jest.fn().mockResolvedValue([]);
  internal.futureSignals = jest.fn().mockResolvedValue([]);
  return { service, internal };
}

describe('FederalMarketService geography composition', () => {
  it('keeps contracts, subawards, and future signals as separate facts', async () => {
    const { service, internal } = harness();
    internal.aggregateContractGeography.mockResolvedValue([
      {
        districtKey: 'VA-10',
        state: 'VA',
        district: '10',
        contractCount: 2,
        contractAmount: 1_200_000,
        subawardCount: 0,
        subawardAmount: null,
      },
    ]);
    internal.aggregateSubawardGeography.mockResolvedValue([
      {
        districtKey: 'VA-10',
        state: 'VA',
        district: '10',
        contractCount: 0,
        contractAmount: null,
        subawardCount: 3,
        subawardAmount: 250_000,
      },
    ]);
    internal.futureSignals.mockResolvedValue([
      {
        id: 'forecast:1',
        source: 'agency_forecast',
        title: 'Future acquisition',
        agency: 'Army',
        state: 'VA',
        districtKey: null,
        date: '2027-04-01',
        geographyBasis: 'state_text',
        sourceUrl: null,
      },
    ]);

    const result = await service.geography('tenant-1', {});

    expect(result.awardedMoneyIncludesFutureOpportunities).toBe(false);
    expect(result.districts).toEqual([
      expect.objectContaining({
        districtKey: 'VA-10',
        contractAmount: 1_200_000,
        subawardAmount: 250_000,
      }),
    ]);
    expect(result.futureSignals).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it('retains healthy rails and reports a failed rail instead of returning an empty result', async () => {
    const { service, internal } = harness();
    internal.aggregateContractGeography.mockResolvedValue([
      {
        districtKey: 'TX-23',
        state: 'TX',
        district: '23',
        contractCount: 1,
        contractAmount: 400_000,
        subawardCount: 0,
        subawardAmount: null,
      },
    ]);
    internal.aggregateSubawardGeography.mockRejectedValue(new Error('subaward table unavailable'));
    internal.futureSignals.mockRejectedValue(new Error('forecast table unavailable'));

    const result = await service.geography('tenant-1', {});

    expect(result.districts).toHaveLength(1);
    expect(result.districts[0]?.contractAmount).toBe(400_000);
    expect(result.futureSignals).toEqual([]);
    expect(result.warnings).toEqual([
      'subaward geography unavailable',
      'future opportunity geography unavailable',
    ]);
  });

  it('passes a client scope through both awarded-money rails', async () => {
    const { service, internal } = harness();
    internal.clientScope.mockResolvedValue({ ueis: ['AAA111BBB222'], names: [] });

    await service.geography('tenant-1', { clientId: 'client-1' });

    expect(internal.clientScope).toHaveBeenCalledWith('tenant-1', 'client-1');
    expect(internal.aggregateContractGeography).toHaveBeenCalledTimes(1);
    expect(internal.aggregateSubawardGeography).toHaveBeenCalledTimes(1);
  });
});
