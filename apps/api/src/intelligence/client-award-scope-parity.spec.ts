import { Prisma } from '@prisma/client';
import { FederalMarketService } from '../federal-spending/federal-market.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IntelligenceService } from './intelligence.service.js';

const CONTRACTOR = '11111111-1111-1111-1111-111111111111';
const SUBSIDIARY = '22222222-2222-2222-2222-222222222222';

describe('client profile and award drilldown scope parity', () => {
  function harness(uei: string | null = 'QM4EZDV15JL8', includeMappings = true) {
    const mappings = includeMappings
      ? [
          {
            source: 'contracting',
            externalId: CONTRACTOR,
            externalName: 'L3HARRIS TECHNOLOGIES, INC.',
            matchBasis: 'exact_legal_name',
            matchTier: 2,
          },
          {
            source: 'contracting',
            externalId: SUBSIDIARY,
            externalName: 'Reviewed Subsidiary',
            matchBasis: 'manual_pin',
            matchTier: 1,
          },
        ]
      : [];
    const contractors = [
      { id: CONTRACTOR, uei: null },
      { id: SUBSIDIARY, uei: 'SUB123456789' },
    ];
    const mappingFind = jest.fn().mockResolvedValue(mappings);
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1', uei }) },
      clientIntelMapping: { findMany: mappingFind },
    };
    const queries: Prisma.Sql[] = [];
    const prisma = {
      withTenant: jest.fn(async (_tenantId, run) => run(tx)),
      federalContractor: { findMany: jest.fn().mockResolvedValue(contractors) },
      $queryRaw: jest.fn(async (query: Prisma.Sql) => {
        queries.push(query);
        if (query.text.includes('FROM federal_contractor')) return contractors;
        if (query.text.includes('AS award_count')) return [];
        if (query.text.includes('COUNT(*)')) return [{ count: 0n, asOf: null }];
        return [];
      }),
    };
    return {
      profile: new IntelligenceService(prisma as unknown as PrismaService),
      explorer: new FederalMarketService(prisma as unknown as PrismaService),
      mappingFind,
      queries,
    };
  }

  it('uses the same reviewed scope for the public profile method, explorer count and explorer rows', async () => {
    const { profile, explorer, mappingFind, queries } = harness();
    await profile.getDistrictNexusSpend('client-1', 'tenant-1');
    await explorer.listContracts('tenant-1', { clientId: 'client-1' });

    const awardQueries = queries.filter((query) => query.text.includes('FROM federal_award'));
    expect(awardQueries).toHaveLength(3);
    const predicates = awardQueries.map((query) =>
      query.text
        .split(/\bWHERE\b/)[1]!
        .split(/\bGROUP BY\b|\bORDER BY\b/)[0]!
        .trim(),
    );
    expect(new Set(predicates).size).toBe(1);
    expect(predicates[0]).toContain(
      "NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name)",
    );
    for (const query of awardQueries) {
      expect(query.values.slice(0, 2)).toEqual([
        ['QM4EZDV15JL8', 'SUB123456789'],
        ['l3harris technologies, inc.', 'reviewed subsidiary'],
      ]);
    }
    // Both entry points must keep candidates, rejected mappings and unapproved
    // corporate rollups out before building the shared row scope.
    for (const [args] of mappingFind.mock.calls) {
      expect(args.where).toMatchObject({
        confirmed: true,
        reviewStatus: 'confirmed',
        rollUpAwards: true,
      });
    }
  });

  it('returns unmapped/empty without reading global awards when no identifiers are approved', async () => {
    const { profile, explorer, queries } = harness(null, false);
    const profileResult = await profile.getDistrictNexusSpend('client-1', 'tenant-1');
    const explorerResult = await explorer.listContracts('tenant-1', { clientId: 'client-1' });
    expect(profileResult.linked).toBe(false);
    expect(explorerResult.total).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
