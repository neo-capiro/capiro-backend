import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  buildClientAwardScope,
  clientAwardScopeSql,
} from '../funding-opportunities/client-award-scope.js';
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
    expect(result).toMatchObject({ futureSignalsAvailability: 'available' });
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
    expect(result).toMatchObject({ futureSignalsAvailability: 'unavailable' });
    expect(result.warnings).toEqual([
      'subaward geography unavailable',
      'future opportunity geography unavailable',
    ]);
  });

  it('passes a client scope through both awarded-money rails', async () => {
    const { service, internal } = harness();
    internal.clientScope.mockResolvedValue({
      contract: { ueis: ['AAA111BBB222'], missingUeiNames: [] },
      subaward: { ueis: ['AAA111BBB222'], missingUeiNames: [] },
    });

    await service.geography('tenant-1', { clientId: 'client-1' });

    expect(internal.clientScope).toHaveBeenCalledWith('tenant-1', 'client-1');
    expect(internal.aggregateContractGeography).toHaveBeenCalledTimes(1);
    expect(internal.aggregateSubawardGeography).toHaveBeenCalledTimes(1);
  });
});

describe('FederalMarketService client award identity', () => {
  const contractorId = '11111111-1111-1111-1111-111111111111';
  const subsidiaryId = '22222222-2222-2222-2222-222222222222';

  function clientHarness(
    mappings: unknown[],
    ueis: Array<{ id: string; uei: string | null }> = [],
  ) {
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1', uei: 'QM4EZDV15JL8' }) },
      clientIntelMapping: { findMany: jest.fn().mockResolvedValue(mappings) },
    };
    const queries: Prisma.Sql[] = [];
    const prisma = {
      withTenant: jest.fn(async (_tenantId, run) => run(tx)),
      $queryRaw: jest.fn(async (query: Prisma.Sql) => {
        queries.push(query);
        if (query.text.includes('FROM federal_contractor')) return ueis;
        if (query.text.includes('COUNT(*)')) return [{ count: 0n, asOf: null }];
        return [];
      }),
    };
    return {
      service: new FederalMarketService(prisma as unknown as PrismaService),
      prisma,
      tx,
      queries,
    };
  }

  it('uses the profile predicate after resolving contractor UUIDs and excludes unreviewed rollups', async () => {
    const mappings = [
      {
        source: 'contracting',
        externalId: contractorId,
        externalName: 'L3HARRIS TECHNOLOGIES, INC.',
        matchBasis: 'exact_legal_name',
        matchTier: 2,
      },
      {
        source: 'contracting',
        externalId: subsidiaryId,
        externalName: 'Reviewed Subsidiary',
        matchBasis: 'manual_pin',
        matchTier: 1,
      },
    ];
    const { service, prisma, tx, queries } = clientHarness(mappings, [
      { id: contractorId, uei: null },
      { id: subsidiaryId, uei: 'SUB123456789' },
    ]);

    await service.listContracts('tenant-1', { clientId: 'client-1' });

    expect(prisma.withTenant).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    expect(tx.clientIntelMapping.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId: 'client-1',
          confirmed: true,
          reviewStatus: 'confirmed',
          rollUpAwards: true,
          source: { in: ['contracting', 'assistance_recipient'] },
        },
      }),
    );
    const resolved = new Map([
      [contractorId, null],
      [subsidiaryId, 'SUB123456789'],
    ]);
    const profilePredicate = clientAwardScopeSql(
      buildClientAwardScope(
        {
          uei: 'QM4EZDV15JL8',
          contractingMappings: mappings,
          assistanceMappings: [],
        },
        resolved,
      ).contract,
    )!;
    const awardQueries = queries.filter((query) => query.text.includes('FROM federal_award'));
    expect(awardQueries).toHaveLength(2);
    for (const query of awardQueries) {
      expect(query.text).toContain(`WHERE ${profilePredicate.text}`);
      expect(query.values.slice(0, profilePredicate.values.length)).toEqual(
        profilePredicate.values,
      );
    }
  });

  it('keeps grant recipients and fuzzy names out of the contract predicate', async () => {
    const { service, queries } = clientHarness([
      {
        source: 'assistance_recipient',
        externalId: 'GRANT1234567',
        externalName: 'Grant Foundation',
        matchBasis: 'manual_pin',
        matchTier: 1,
      },
      {
        source: 'contracting',
        externalId: 'not-a-uuid',
        externalName: 'Coincidental Company',
        matchBasis: 'fuzzy_name',
        matchTier: 4,
      },
    ]);
    await service.listContracts('tenant-1', { clientId: 'client-1' });
    expect(queries.some((query) => query.text.includes('FROM federal_contractor'))).toBe(false);
    const countQuery = queries.find((query) => query.text.includes('COUNT(*)'))!;
    expect(countQuery.values).toEqual([['QM4EZDV15JL8']]);
    expect(countQuery.text).not.toContain('lower(contractor_name)');
  });

  it('pairs each subaward participant name with its own missing-UEI guard', async () => {
    const { service, queries } = clientHarness([
      {
        source: 'contracting',
        externalId: 'not-a-uuid',
        externalName: 'Reviewed Subsidiary',
        matchBasis: 'manual_pin',
        matchTier: 1,
      },
    ]);
    await service.listSubawards('tenant-1', { clientId: 'client-1' });
    const countQuery = queries.find((query) => query.text.includes('COUNT(*)'))!;
    expect(countQuery.text).toContain(
      "NULLIF(BTRIM(prime_recipient_uei), '') IS NULL AND lower(prime_recipient_name)",
    );
    expect(countQuery.text).toContain(
      "NULLIF(BTRIM(subawardee_uei), '') IS NULL AND lower(subawardee_name)",
    );
    expect(countQuery.values).toEqual([
      ['QM4EZDV15JL8'],
      ['reviewed subsidiary'],
      ['QM4EZDV15JL8'],
      ['reviewed subsidiary'],
    ]);
  });
});
