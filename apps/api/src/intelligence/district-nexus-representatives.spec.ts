import { IntelligenceService } from './intelligence.service.js';

/**
 * Unit tests for the current-representative overlay on District Nexus spend
 * rows (WS-A, LegiStorm gaps/enrichment plan). getDistrictNexusSpend attaches
 * `representatives: { house, senate }` per district, resolved from
 * congress_member — deliberately independent of the facility-based
 * RepresentationResolverService (a client can have spend in a district with
 * no facility there).
 *
 * Pinned regressions:
 *  1. A true at-large seat (member.district === null, USAspending code '00')
 *     resolves via districtMatchesHouse's '00' convention.
 *  2. USAspending's OTHER non-numbered sentinels ('98' non-voting delegate,
 *     '90'/'ZZ' multiple-or-undefined) must NOT be misattributed to an
 *     at-large member — normalizeDistrict collapses all four into one 'AL'
 *     bucket for the census join, but districtCodeForHouseMatch must NOT
 *     collapse '98'/'90'/'ZZ' the same way, or every DC/territory-style row
 *     would wrongly show a random at-large member as "the representative".
 *  3. An ordinary numbered district picks the matching member out of several
 *     same-state House members, not just the first one.
 *  4. Senate resolves independently of whether House resolved.
 *  5. Exactly ONE congressMember.findMany call per request regardless of how
 *     many distinct states are on the spend rows (no N+1).
 *  6. The query filter and the grouping-by-state both go through the
 *     2-letter-code <-> full-name translation (CongressMember.state stores
 *     "Texas", not "TX") — member fixtures below use full names to mirror
 *     the real column, and the batching test pins the translated filter.
 */
describe('IntelligenceService.getDistrictNexusSpend — representative overlay', () => {
  const tenantId = '00000000-0000-0000-0000-000000000001';
  const clientId = '00000000-0000-0000-0000-000000000010';

  function makeService(opts: { spendRows: unknown[]; members: unknown[] }) {
    const tenantTx = {
      clientIntelMapping: {
        findMany: jest.fn(async () => [{ externalName: 'Acme Defense Corp' }]),
      },
    };
    const prisma: any = {
      withTenant: jest.fn(async (_t: string, run: (tx: any) => Promise<any>) => run(tenantTx)),
      congressMember: { findMany: jest.fn(async () => opts.members) },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(opts.spendRows) // federal_award aggregate
        .mockResolvedValueOnce([]), // census_district join — not under test here
    };
    return { service: new IntelligenceService(prisma), prisma };
  }

  test('at-large seat (district=null) resolves via the "00" convention, not misattributed', async () => {
    const { service, prisma } = makeService({
      spendRows: [
        { pop_state: 'WY', pop_district: '00', award_count: 5n, total_amount: 1000 },
      ],
      members: [
        {
          bioguideId: 'W001H',
          fullName: 'Wyoming House Member',
          party: 'Republican',
          state: 'Wyoming',
          district: null,
          chamber: 'house',
        },
        {
          bioguideId: 'W002S',
          fullName: 'Wyoming Senator A',
          party: 'Republican',
          state: 'Wyoming',
          district: null,
          chamber: 'senate',
        },
        {
          bioguideId: 'W003S',
          fullName: 'Wyoming Senator B',
          party: 'Democrat',
          state: 'Wyoming',
          district: null,
          chamber: 'senate',
        },
      ],
    });

    const result: any = await service.getDistrictNexusSpend(clientId, tenantId);

    expect(result.linked).toBe(true);
    expect(result.districts).toHaveLength(1);
    expect(result.districts[0].representatives.house?.bioguideId).toBe('W001H');
    expect(result.districts[0].representatives.senate.map((s: any) => s.bioguideId).sort()).toEqual([
      'W002S',
      'W003S',
    ]);
    expect(prisma.congressMember.findMany).toHaveBeenCalledTimes(1);
  });

  test('non-voting-delegate sentinel ("98") never resolves a House rep, even when a same-state member has district=null', async () => {
    // Regression for the exact bug the plan flagged: normalizeDistrict
    // collapses '98' to the same 'AL' bucket as true at-large '00'. If the
    // representative bridge naively reused that collapsed value, this DC
    // member (district=null, same as a real at-large member) would be
    // wrongly shown as "the representative" for a '98' row.
    const { service } = makeService({
      spendRows: [{ pop_state: 'DC', pop_district: '98', award_count: 2n, total_amount: 500 }],
      members: [
        {
          bioguideId: 'DC001',
          fullName: 'DC Delegate',
          party: 'Democrat',
          state: 'District of Columbia',
          district: null,
          chamber: 'house',
        },
      ],
    });

    const result: any = await service.getDistrictNexusSpend(clientId, tenantId);

    expect(result.districts[0].representatives.house).toBeNull();
    expect(result.districts[0].representatives.senate).toEqual([]);
  });

  test('"90" and "ZZ" (multiple/undefined district) also never resolve a House rep', async () => {
    const { service } = makeService({
      spendRows: [
        { pop_state: 'CA', pop_district: '90', award_count: 1n, total_amount: 100 },
        { pop_state: 'CA', pop_district: 'ZZ', award_count: 1n, total_amount: 200 },
      ],
      members: [
        {
          bioguideId: 'CAAL',
          fullName: 'Should Not Be Shown',
          party: 'Democrat',
          state: 'California',
          district: null,
          chamber: 'house',
        },
      ],
    });

    const result: any = await service.getDistrictNexusSpend(clientId, tenantId);

    expect(result.districts).toHaveLength(2);
    for (const d of result.districts) {
      expect(d.representatives.house).toBeNull();
    }
  });

  test('an ordinary numbered district picks the matching member, not the first same-state House member', async () => {
    const { service } = makeService({
      spendRows: [{ pop_state: 'TX', pop_district: '23', award_count: 3n, total_amount: 700 }],
      members: [
        {
          bioguideId: 'TX007',
          fullName: 'TX-7 Member',
          party: 'Democrat',
          state: 'Texas',
          district: 7,
          chamber: 'house',
        },
        {
          bioguideId: 'TX023',
          fullName: 'TX-23 Member',
          party: 'Republican',
          state: 'Texas',
          district: 23,
          chamber: 'house',
        },
        {
          bioguideId: 'TXSEN',
          fullName: 'TX Senator',
          party: 'Republican',
          state: 'Texas',
          district: null,
          chamber: 'senate',
        },
      ],
    });

    const result: any = await service.getDistrictNexusSpend(clientId, tenantId);

    expect(result.districts[0].representatives.house?.bioguideId).toBe('TX023');
    expect(result.districts[0].representatives.senate.map((s: any) => s.bioguideId)).toEqual([
      'TXSEN',
    ]);
  });

  test('batches exactly ONE congressMember query across multiple distinct-state rows (no N+1)', async () => {
    const { service, prisma } = makeService({
      spendRows: [
        { pop_state: 'TX', pop_district: '23', award_count: 1n, total_amount: 100 },
        { pop_state: 'WY', pop_district: '00', award_count: 1n, total_amount: 200 },
        { pop_state: 'CO', pop_district: '02', award_count: 1n, total_amount: 300 },
      ],
      members: [],
    });

    await service.getDistrictNexusSpend(clientId, tenantId);

    expect(prisma.congressMember.findMany).toHaveBeenCalledTimes(1);
    const call = prisma.congressMember.findMany.mock.calls[0][0];
    // Regression: CongressMember.state stores the FULL name, not the
    // 2-letter USAspending code on the spend rows — the query filter must
    // be translated, or it silently matches zero rows for every state.
    expect(new Set(call.where.state.in)).toEqual(new Set(['Texas', 'Wyoming', 'Colorado']));
  });

  test('rows with no resolved district (unmapped) never trigger a representative lookup', async () => {
    const { service, prisma } = makeService({
      spendRows: [{ pop_state: null, pop_district: null, award_count: 4n, total_amount: 900 }],
      members: [],
    });

    const result: any = await service.getDistrictNexusSpend(clientId, tenantId);

    expect(result.districts).toHaveLength(0);
    expect(result.unmappedAmount).toBe(900);
    // spendStates is empty (no row has a resolved pop_state/pop_district), so
    // the batched lookup must be skipped entirely — not called with an empty
    // filter, not called at all.
    expect(prisma.congressMember.findMany).not.toHaveBeenCalled();
  });
});
