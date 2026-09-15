import { Prisma } from '@prisma/client';
import { FederalMarketService } from '../federal-spending/federal-market.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { IntelligenceService } from './intelligence.service.js';

const CONTRACTOR = '11111111-1111-1111-1111-111111111111';
const SUBSIDIARY = '22222222-2222-2222-2222-222222222222';

/**
 * The two award-scope policies for the client profile (deliberate, documented —
 * do NOT collapse them; see federal-market.service.ts:596-599 and the
 * capiro-district-nexus runbook):
 *
 *  1. **Profile totals** (`IntelligenceService.getDistrictNexusSpend`, via
 *     `buildClientAwardScope` + `clientAwardScopeSql`) intentionally recover
 *     historical award rows whose source UEI is missing: an exact UEI match OR
 *     a reviewed name match applied ONLY to rows whose UEI is NULL/blank.
 *  2. **Explorer + drawer** (`FederalMarketService.listContracts`, via
 *     `buildAwardIdentityRails` + `awardIdentityRailSql`) enforce District Nexus
 *     rail exclusivity: a verified UEI rail is never OR'd with a reviewed name,
 *     so a conflicting-UEI row can never leak into the client.
 *
 * Both policies share the same non-negotiable invariants, pinned here: only
 * confirmed + reviewStatus=confirmed + rollUpAwards=true mappings contribute;
 * the verified UEI set is identical on both rails; and a source row carrying a
 * nonblank UEI that conflicts with the client's verified UEIs is excluded by
 * BOTH (the profile's name fallback requires a NULL/blank source UEI, and the
 * explorer matches UEI only).
 */
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

  it('applies the two documented award-scope policies with shared identity invariants', async () => {
    const { profile, explorer, mappingFind, queries } = harness();
    await profile.getDistrictNexusSpend('client-1', 'tenant-1');
    await explorer.listContracts('tenant-1', { clientId: 'client-1' });

    const awardQueries = queries.filter((query) => query.text.includes('FROM federal_award'));
    // One profile spend query + explorer count + explorer rows.
    expect(awardQueries).toHaveLength(3);
    const predicates = awardQueries.map((query) =>
      query.text
        .split(/\bWHERE\b/)[1]!
        .split(/\bGROUP BY\b|\bORDER BY\b/)[0]!
        .trim(),
    );

    // ── Shared invariant: the verified UEI set is identical on every rail. ──
    for (const query of awardQueries) {
      expect(query.values[0]).toEqual(['QM4EZDV15JL8', 'SUB123456789']);
    }

    // ── Policy 1 (profile): missing-UEI recovery via reviewed names, applied
    //    ONLY to source rows whose UEI is NULL/blank (conflicting-UEI rows are
    //    excluded, never overridden by a name). ──
    const profilePredicate = predicates[0]!;
    expect(profilePredicate).toContain('recipient_uei = ANY($1::text[])');
    expect(profilePredicate).toContain(
      "NULLIF(BTRIM(recipient_uei), '') IS NULL AND lower(contractor_name)",
    );
    expect(awardQueries[0]!.values[1]).toEqual([
      'l3harris technologies, inc.',
      'reviewed subsidiary',
    ]);

    // ── Policy 2 (explorer count + rows): rail-exact UEI only — no name
    //    fallback, no arbitrary name match. ──
    for (const explorerPredicate of predicates.slice(1)) {
      expect(explorerPredicate).toContain('recipient_uei = ANY($1::text[])');
      expect(explorerPredicate).not.toMatch(/lower\(contractor_name\)/);
      expect(explorerPredicate).not.toMatch(/NULLIF\(BTRIM/);
    }

    // ── Shared invariant: candidates, rejected mappings and unapproved
    //    corporate rollups are filtered out before either scope is built. ──
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
