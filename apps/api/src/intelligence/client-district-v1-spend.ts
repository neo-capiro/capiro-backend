import type { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '@prisma/client';
import { resolveStateName, abbrForStateName } from '../common/us-states.js';
import {
  buildClientAwardScope,
  clientAwardScopeSql,
} from '../funding-opportunities/client-award-scope.js';
import {
  districtNexusContractorIdsToResolve,
  type DistrictNexusIdentitySeed,
} from '../district-nexus/district-nexus.identity.js';
import {
  districtCodeForHouseMatch,
  normalizeDistrictForCensus as normalizeDistrict,
} from '../common/district-code.util.js';
import {
  districtMatchesHouse,
  type FederalMemberSummary,
} from '../clients/representation-resolver.service.js';

export interface ClientDistrictV1SpendPorts {
  resolveContractorUeisForAlerts(contractorIds: string[]): Promise<Map<string, string | null>>;
}

type SpendRow = {
  pop_state: string | null;
  pop_district: string | null;
  award_count: bigint;
  total_amount: number | null;
};
type SpendCensusRow = {
  state: string;
  district: string;
  total_population: number | null;
  median_household_income: number | null;
  labor_force_size: number | null;
  unemployment_rate: number | null;
  percent_veteran: number | null;
  data_year: number;
};
type MembersByState = Map<
  string,
  { house: FederalMemberSummary[]; senate: FederalMemberSummary[] }
>;

type ContractingMapping = Prisma.ClientIntelMappingGetPayload<{
  select: { externalId: true; externalName: true; matchBasis: true; matchTier: true };
}>;

export class ClientDistrictV1Spend {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientDistrictV1SpendPorts,
  ) {}

  async getDistrictNexusSpend(clientId: string, tenantId: string) {
    const [mappings, client] = await this.readIdentitySnapshot(clientId, tenantId);

    const { contractorNames, seed } = this.buildIdentitySnapshot(clientId, mappings, client);

    const contractorUeis = await this.ports.resolveContractorUeisForAlerts(
      districtNexusContractorIdsToResolve([seed]),
    );

    const scope = buildClientAwardScope(
      {
        uei: client?.uei ?? null,
        contractingMappings: mappings,
        assistanceMappings: [],
      },
      contractorUeis,
    );

    const predicate = clientAwardScopeSql(scope.contract);

    if (!predicate) {
      return {
        linked: false as const,
        reason: 'no_confirmed_contracting_mapping',
        contractorNames: [],
        totalAwards: 0,
        totalAmount: 0,
        districts: [],
        unmappedAmount: 0,
        disclaimer:
          'Spend is matched to this client via confirmed USAspending contractor mappings. Confirm a contracting source mapping in Manage Sources to populate district spend.',
      };
    }

    const spendRows = await this.readSpendRows(predicate);

    // 3. Join CensusDistrict demographics for the districts we resolved.
    const districtKeys = spendRows
      .filter((r) => r.pop_state && r.pop_district)
      .map((r) => `${r.pop_state}-${normalizeDistrict(r.pop_district)}`);

    const censusRows = districtKeys.length ? await this.readCensusDistricts(districtKeys) : [];

    const censusMap = new Map(censusRows.map((c) => [`${c.state}-${c.district}`, c]));

    const spendStateNames = this.representativeStateNames(spendRows);

    const repMembers = spendStateNames.length
      ? await this.readRepresentatives(spendStateNames)
      : [];

    const membersByState = this.catalogRepresentatives(repMembers);

    const { totalAwards, totalAmount, unmappedAmount, districts } = this.projectSpendDistricts(
      spendRows,
      censusMap,
      membersByState,
    );

    return {
      linked: true as const,
      contractorNames,
      totalAwards,
      totalAmount,
      districtCount: districts.length,
      unmappedAmount,
      districts,
      disclaimer:
        'Imported federal contract spend (USAspending; current ingestion covers Department of Defense contracts) matched by UEI or reviewed exact names on awards missing UEIs, grouped by place-of-performance congressional district. Awards without a resolved district are shown as unmapped. Public data; for intelligence, not legal or compliance advice.',
    };
  }

  private readIdentitySnapshot(clientId: string, tenantId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      Promise.all([
        tx.clientIntelMapping.findMany({
          where: {
            clientId,
            source: 'contracting',
            confirmed: true,
            reviewStatus: 'confirmed',
            rollUpAwards: true,
          },
          select: { externalId: true, externalName: true, matchBasis: true, matchTier: true },
        }),
        tx.client.findFirst({ where: { id: clientId }, select: { uei: true } }),
      ]),
    );
  }

  private buildIdentitySnapshot(
    clientId: string,
    mappings: ContractingMapping[],
    client: { uei: string | null } | null,
  ) {
    // Unchanged public shape (§10): every confirmed mapping's externalName,
    // independent of which basis the canonical identity below settles on.
    const contractorNames = Array.from(
      new Set(mappings.map((m) => m.externalName.trim()).filter((n) => n.length > 0)),
    );

    // Contractor UUID -> UEI resolution happens OUTSIDE the tenant
    // transaction (§4) — a global `federal_contractor` reference-table read.
    const seed: DistrictNexusIdentitySeed = {
      clientId,
      clientName: '',
      uei: client?.uei ?? null,
      mappings: mappings.map((m) => ({
        source: 'contracting',
        externalId: m.externalId,
        externalName: m.externalName,
        matchBasis: m.matchBasis,
        matchTier: m.matchTier,
      })),
    };

    return { contractorNames, seed };
  }

  private readSpendRows(predicate: Prisma.Sql) {
    return this.prisma.$queryRaw<
      Array<{
        pop_state: string | null;
        pop_district: string | null;
        award_count: bigint;
        total_amount: number | null;
      }>
    >(Prisma.sql`
      SELECT pop_state, pop_congressional_district AS pop_district,
             COUNT(*)::bigint AS award_count,
             COALESCE(SUM(amount), 0)::float8 AS total_amount
      FROM federal_award
      WHERE ${predicate}
      GROUP BY pop_state, pop_congressional_district
    `);
  }

  private readCensusDistricts(districtKeys: string[]) {
    return this.prisma.$queryRaw<
      Array<{
        state: string;
        district: string;
        total_population: number | null;
        median_household_income: number | null;
        labor_force_size: number | null;
        unemployment_rate: number | null;
        percent_veteran: number | null;
        data_year: number;
      }>
    >`
          SELECT DISTINCT ON (state, district)
            state, district, total_population, median_household_income,
            labor_force_size, unemployment_rate, percent_veteran, data_year
          FROM census_district
          WHERE state || '-' || district = ANY(${districtKeys}::text[])
          ORDER BY state, district, congress DESC
        `;
  }

  private representativeStateNames(spendRows: SpendRow[]) {
    // 4. Batch-resolve CURRENT federal representatives (House + both
    //    Senators) for every state that has a resolved district — ONE query
    //    regardless of row count, matched in-memory per row below (never a
    //    per-row query). Deliberately INDEPENDENT of the facility-based
    //    "Your representatives" block (RepresentationResolverService /
    //    getClientRepresentation): a client can have spend in a district
    //    with no facility there, which the facility-based resolver never sees.
    const spendStates = Array.from(
      new Set(
        spendRows.filter((r) => r.pop_state && r.pop_district).map((r) => r.pop_state as string),
      ),
    );

    // CongressMember.state stores the FULL state name ("Connecticut"), but
    // USAspending's pop_state is a 2-letter code — translate before querying
    // or this silently matches zero rows for every state.
    const spendStateNames = spendStates
      .map((code) => resolveStateName(code))
      .filter((name): name is string => name !== undefined);

    return spendStateNames;
  }

  private readRepresentatives(spendStateNames: string[]) {
    return this.prisma.congressMember.findMany({
      where: {
        isCurrent: true,
        chamber: { in: ['house', 'senate'] },
        state: { in: spendStateNames },
      },
      select: {
        bioguideId: true,
        fullName: true,
        party: true,
        state: true,
        district: true,
        chamber: true,
      },
    });
  }

  private catalogRepresentatives(repMembers: FederalMemberSummary[]) {
    // Keyed by the SAME 2-letter code as `r.pop_state` below (not the DB's
    // full-name state) so the per-row lookup needs no further translation.
    const membersByState = new Map<
      string,
      { house: FederalMemberSummary[]; senate: FederalMemberSummary[] }
    >();

    for (const m of repMembers) {
      const abbr = m.state ? abbrForStateName(m.state) : undefined;
      if (!abbr) continue;
      const bucket = membersByState.get(abbr) ?? { house: [], senate: [] };
      if (m.chamber === 'house') bucket.house.push(m);
      else if (m.chamber === 'senate') bucket.senate.push(m);
      membersByState.set(abbr, bucket);
    }

    return membersByState;
  }

  private projectSpendDistricts(
    spendRows: SpendRow[],
    censusMap: Map<string, SpendCensusRow>,
    membersByState: MembersByState,
  ) {
    let totalAwards = 0;

    let totalAmount = 0;

    let unmappedAmount = 0;

    const districts = spendRows
      .map((r) => {
        const count = Number(r.award_count);
        const amount = Number(r.total_amount ?? 0);
        totalAwards += count;
        totalAmount += amount;
        // Rows without a resolved district roll into the "unmapped" bucket.
        if (!r.pop_state || !r.pop_district) {
          unmappedAmount += amount;
          return null;
        }
        const dnum = normalizeDistrict(r.pop_district);
        const key = `${r.pop_state}-${dnum}`;
        const c = censusMap.get(key);
        const stateMembers = membersByState.get(r.pop_state);
        const houseCode = districtCodeForHouseMatch(r.pop_district);
        const house = houseCode
          ? (stateMembers?.house.find((m) => districtMatchesHouse(houseCode, m.district)) ?? null)
          : null;
        return {
          district: key,
          state: r.pop_state,
          districtNumber: dnum,
          awardCount: count,
          totalAmount: amount,
          demographics: c
            ? {
                totalPopulation: c.total_population,
                medianHouseholdIncome: c.median_household_income,
                laborForceSize: c.labor_force_size,
                unemploymentRate: c.unemployment_rate,
                percentVeteran: c.percent_veteran,
                dataYear: c.data_year,
              }
            : null,
          // Current representative(s). "Current" — the district may reflect
          // the map in effect when the award was recorded (redistricting
          // vintage skew), so this is NOT a claim the shown member held the
          // seat at award time. house is null when the seat can't be
          // determined (non-voting delegate / multiple-or-undefined district
          // sentinel), never a guess; senate resolves independently of the
          // House seat since it only needs the state.
          representatives: { house, senate: stateMembers?.senate ?? [] },
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null)
      .sort((a, b) => b.totalAmount - a.totalAmount);

    return { totalAwards, totalAmount, unmappedAmount, districts };
  }
}
