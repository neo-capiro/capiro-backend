/**
 * District Impact Engine (Phase 1 M1.3, PD2) — pure deterministic
 * representation resolver, both rails. NO LLM, no network; a plain join over
 * already-geocoded facility districts. Shared by the UI (M1.4) and the M5
 * agent's targeting-brief validator gate — both must read the SAME source of
 * truth so a validated claim actually means something.
 *
 * "Do not ask a language model which district contains an address" (agentic
 * doc §7) — the geocoder (M1.2) resolves the district; this resolver only
 * joins an already-resolved district to the people who hold it.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeDistrictCode } from './district-code.util.js';
import { districtMatchesHouse } from '../common/district-code.util.js';
import { resolveStateName } from '../common/us-states.js';

export interface ResolvedRepresentation {
  unresolved: false;
  federal: {
    house: FederalMemberSummary | null;
    senate: FederalMemberSummary[];
  };
  state: {
    lower: StateLegislatorSummary | null;
    upper: StateLegislatorSummary | null;
  };
}
export interface UnresolvedRepresentation {
  unresolved: true;
  reason: 'no_geocode' | 'no_state';
}
export type RepresentationResult = ResolvedRepresentation | UnresolvedRepresentation;

export interface FederalMemberSummary {
  bioguideId: string;
  fullName: string;
  party: string | null;
  state: string | null;
  district: number | null;
  chamber: string;
}
export interface StateLegislatorSummary {
  id: string;
  name: string;
  state: string;
  chamber: string | null;
  district: string | null;
  party: string | null;
  /** OpenStates profile — no in-app directory profile exists for state legislators yet. */
  url: string | null;
}

export interface FacilityDistrictInput {
  state: string | null;
  congressionalDistrict: string | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
  geocodeStatus: string | null;
}

/**
 * W2.2: a facility is resolvable once EITHER the geocoder has placed it OR a
 * manual entry supplies at least one district — never gated on
 * `geocodeStatus` alone. Before this fix, a manually-entered facility
 * (`districtSource='user'`, `geocodeStatus` still `null`/`no_match`/`error`)
 * was treated as fully unresolved even when it carried a hand-typed
 * `stateHouseDistrict`/`stateSenateDistrict`/`congressionalDistrict` —
 * silently dropping it from the "Your representatives" block, the chokepoint
 * footprint, and both inverse joins below. One definition, used by the
 * forward lookup AND every inverse `clientFacility` query in this file.
 */
function isResolvableFacility(f: {
  geocodeStatus: string | null;
  congressionalDistrict: string | null;
  stateHouseDistrict: string | null;
  stateSenateDistrict: string | null;
}): boolean {
  return (
    f.geocodeStatus === 'matched' ||
    !!f.congressionalDistrict ||
    !!f.stateHouseDistrict ||
    !!f.stateSenateDistrict
  );
}

/** Prisma OR-fragment mirroring `isResolvableFacility` for `findMany` `where` clauses. */
const RESOLVABLE_FACILITY_OR = [
  { geocodeStatus: 'matched' },
  { congressionalDistrict: { not: null } },
  { stateHouseDistrict: { not: null } },
  { stateSenateDistrict: { not: null } },
];

@Injectable()
export class RepresentationResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Who represents this facility's footprint — federal House + both
   * senators, state upper + lower. Returns an explicit `unresolved` shape
   * (never a silent empty) when the facility has no geocoded district, per
   * PD2/M1.3.
   */
  async representativesForFacility(facility: FacilityDistrictInput): Promise<RepresentationResult> {
    if (!facility.state) return { unresolved: true, reason: 'no_state' };
    if (!isResolvableFacility(facility)) {
      return { unresolved: true, reason: 'no_geocode' };
    }

    const [house, senate, lower, upper] = await Promise.all([
      this.resolveHouse(facility.state, facility.congressionalDistrict),
      this.resolveSenate(facility.state),
      this.resolveStateChamber(facility.state, 'lower', facility.stateHouseDistrict),
      this.resolveStateChamber(facility.state, 'upper', facility.stateSenateDistrict),
    ]);

    return {
      unresolved: false,
      federal: { house, senate },
      state: { lower, upper },
    };
  }

  /**
   * Resolve representation for MANY facilities in a fixed four queries.
   *
   * `representativesForFacility` issues four `findMany` calls per facility
   * inside a `Promise.all`. That is fine for one client's handful of sites and
   * actively dangerous anywhere else: embedding it in the District Nexus client
   * payload makes it 4 x N_facilities, and the firm-wide map aggregate would
   * multiply that again by client count. Holding dozens of pooled connections
   * open on concurrent short queries is precisely the shape that starved the
   * Prisma pool during the graph-sync incident, and the reason the District
   * Nexus service resolves identifiers first and aggregates second.
   *
   * So: gather the distinct states once, issue ONE query per rail across all of
   * them, and do the district matching in memory. Four queries regardless of
   * whether there is one facility or four hundred.
   */
  async representationForFacilities(
    facilities: FacilityDistrictInput[],
  ): Promise<RepresentationResult[]> {
    // Facility state codes are 2-letter; CongressMember.state holds the FULL
    // name. Translate once and keep both directions.
    const stateCodes = Array.from(
      new Set(facilities.map((f) => f.state).filter((s): s is string => !!s)),
    );
    const stateNameByCode = new Map<string, string>();
    for (const code of stateCodes) {
      const name = resolveStateName(code);
      if (name) stateNameByCode.set(code, name);
    }
    const stateNames = Array.from(new Set(stateNameByCode.values()));

    const memberSelect = {
      bioguideId: true,
      fullName: true,
      party: true,
      state: true,
      district: true,
      chamber: true,
    } as const;
    const legislatorSelect = {
      id: true,
      name: true,
      state: true,
      chamber: true,
      district: true,
      party: true,
      url: true,
    } as const;

    const [houseRows, senateRows, lowerRows, upperRows] = await Promise.all([
      stateNames.length
        ? this.prisma.congressMember.findMany({
            where: { chamber: 'house', state: { in: stateNames }, isCurrent: true },
            select: memberSelect,
          })
        : Promise.resolve([]),
      stateNames.length
        ? this.prisma.congressMember.findMany({
            where: { chamber: 'senate', state: { in: stateNames }, isCurrent: true },
            select: memberSelect,
          })
        : Promise.resolve([]),
      stateCodes.length
        ? this.prisma.stateLegislator.findMany({
            where: { state: { in: stateCodes }, chamber: 'lower', active: true },
            select: legislatorSelect,
          })
        : Promise.resolve([]),
      stateCodes.length
        ? this.prisma.stateLegislator.findMany({
            where: { state: { in: stateCodes }, chamber: 'upper', active: true },
            select: legislatorSelect,
          })
        : Promise.resolve([]),
    ]);

    const groupBy = <T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> => {
      const map = new Map<string, T[]>();
      for (const row of rows) {
        const k = key(row);
        if (!k) continue;
        const bucket = map.get(k);
        if (bucket) bucket.push(row);
        else map.set(k, [row]);
      }
      return map;
    };

    const houseByStateName = groupBy(houseRows, (m) => m.state);
    const senateByStateName = groupBy(senateRows, (m) => m.state);
    const lowerByState = groupBy(lowerRows, (l) => l.state);
    const upperByState = groupBy(upperRows, (l) => l.state);

    return facilities.map((facility) => {
      if (!facility.state) return { unresolved: true, reason: 'no_state' };
      if (!isResolvableFacility(facility)) return { unresolved: true, reason: 'no_geocode' };

      const stateName = stateNameByCode.get(facility.state) ?? null;

      // Same at-large semantics as resolveHouse: districtMatchesHouse encodes
      // the '00' <-> NULL convention, so this is not a plain equality join.
      const house =
        facility.congressionalDistrict && stateName
          ? ((houseByStateName.get(stateName) ?? []).find((m) =>
              districtMatchesHouse(facility.congressionalDistrict, m.district),
            ) ?? null)
          : null;

      const senate = stateName ? (senateByStateName.get(stateName) ?? []) : [];

      const pickChamber = (
        rows: StateLegislatorSummary[],
        district: string | null,
      ): StateLegislatorSummary | null => {
        if (!district) return null;
        const target = normalizeDistrictCode(district);
        if (!target) return null;
        return rows.find((l) => normalizeDistrictCode(l.district) === target) ?? null;
      };

      return {
        unresolved: false,
        federal: { house, senate },
        state: {
          lower: pickChamber(lowerByState.get(facility.state) ?? [], facility.stateHouseDistrict),
          upper: pickChamber(upperByState.get(facility.state) ?? [], facility.stateSenateDistrict),
        },
      };
    });
  }

  /**
   * "Who represents your footprint" — every facility for a client, each with
   * its resolved representation. Host for the M1.4 Client Intelligence "Your
   * representatives" block + `GET /api/clients/:clientId/representation`.
   */
  async representationForClient(
    tenantId: string,
    clientId: string,
  ): Promise<
    Array<{
      facility: { id: string; name: string; city: string | null; state: string | null };
      representation: RepresentationResult;
    }>
  > {
    const facilities = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientFacility.findMany({
        where: { tenantId, clientId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    // Batched: four queries for the whole client, not four per facility.
    const representations = await this.representationForFacilities(facilities);
    return facilities.map((f, i) => ({
      facility: { id: f.id, name: f.name, city: f.city, state: f.state },
      representation: representations[i]!,
    }));
  }

  /**
   * Tenant-wide inverse for a FEDERAL member — every client (any client, not
   * just one) this member represents at least one facility for. Host for the
   * M1.4 Directory profile modal's "Represents client facilities" pill —
   * the join that discovery confirmed "does NOT exist today". House uses the
   * at-large sentinel rule (PD1.3); Senate matches on state alone.
   */
  async clientsRepresentedByMember(
    tenantId: string,
    member: { bioguideId: string; chamber: string; state: string | null; district: number | null },
  ): Promise<Array<{ clientId: string; clientName: string; facilities: Array<{ id: string; name: string }> }>> {
    if (!member.state) return [];
    return this.prisma.withTenant(tenantId, async (tx) => {
      const facilities = await tx.clientFacility.findMany({
        where: { tenantId, state: member.state, OR: RESOLVABLE_FACILITY_OR },
        select: {
          id: true,
          name: true,
          congressionalDistrict: true,
          clientId: true,
          client: { select: { id: true, name: true } },
        },
      });
      const matched =
        member.chamber === 'senate'
          ? facilities
          : facilities.filter((f) => districtMatchesHouse(f.congressionalDistrict, member.district));
      const byClient = new Map<string, { clientId: string; clientName: string; facilities: Array<{ id: string; name: string }> }>();
      for (const f of matched) {
        const entry = byClient.get(f.clientId) ?? {
          clientId: f.clientId,
          clientName: f.client.name,
          facilities: [],
        };
        entry.facilities.push({ id: f.id, name: f.name });
        byClient.set(f.clientId, entry);
      }
      return Array.from(byClient.values());
    });
  }

  /** Inverse: which of a client's facilities does this member represent? */
  async facilitiesForMember(
    tenantId: string,
    clientId: string,
    member: { chamber: string; state: string | null; district?: number | null; type: 'federal' },
  ): Promise<Array<{ id: string; name: string }>>;
  async facilitiesForMember(
    tenantId: string,
    clientId: string,
    member: { chamber: string; state: string; district: string | null; type: 'state' },
  ): Promise<Array<{ id: string; name: string }>>;
  async facilitiesForMember(
    tenantId: string,
    clientId: string,
    member:
      | { chamber: string; state: string | null; district?: number | null; type: 'federal' }
      | { chamber: string; state: string; district: string | null; type: 'state' },
  ): Promise<Array<{ id: string; name: string }>> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      if (member.type === 'federal') {
        if (!member.state) return [];
        if (member.chamber === 'senate') {
          return tx.clientFacility.findMany({
            where: { tenantId, clientId, state: member.state, OR: RESOLVABLE_FACILITY_OR },
            select: { id: true, name: true },
          });
        }
        // House: at-large ("00") <-> stored district NULL, per the same
        // sentinel rule the resolver uses for the forward direction.
        const facilities = await tx.clientFacility.findMany({
          where: { tenantId, clientId, state: member.state, OR: RESOLVABLE_FACILITY_OR },
          select: { id: true, name: true, congressionalDistrict: true },
        });
        return facilities
          .filter((f) => districtMatchesHouse(f.congressionalDistrict, member.district ?? null))
          .map((f) => ({ id: f.id, name: f.name }));
      }
      const facilities = await tx.clientFacility.findMany({
        where: { tenantId, clientId, state: member.state, OR: RESOLVABLE_FACILITY_OR },
        select: {
          id: true,
          name: true,
          stateHouseDistrict: true,
          stateSenateDistrict: true,
        },
      });
      const targetDistrict = normalizeDistrictCode(member.district);
      const column = member.chamber === 'lower' ? 'stateHouseDistrict' : 'stateSenateDistrict';
      return facilities
        .filter((f) => normalizeDistrictCode(f[column]) === targetDistrict)
        .map((f) => ({ id: f.id, name: f.name }));
    });
  }

  private async resolveHouse(
    state: string,
    congressionalDistrict: string | null,
  ): Promise<FederalMemberSummary | null> {
    if (!congressionalDistrict) return null;
    // CongressMember.state stores the FULL state name ("Connecticut"), but
    // `state` here is the facility's 2-letter code (ClientFacility.state) —
    // translate first or this silently matches zero rows for every state.
    const stateName = resolveStateName(state);
    if (!stateName) return null;
    const members = await this.prisma.congressMember.findMany({
      where: { chamber: 'house', state: stateName, isCurrent: true },
      select: {
        bioguideId: true,
        fullName: true,
        party: true,
        state: true,
        district: true,
        chamber: true,
      },
    });
    const match = members.find((m) => districtMatchesHouse(congressionalDistrict, m.district));
    return match ?? null;
  }

  private async resolveSenate(state: string): Promise<FederalMemberSummary[]> {
    const stateName = resolveStateName(state);
    if (!stateName) return [];
    return this.prisma.congressMember.findMany({
      where: { chamber: 'senate', state: stateName, isCurrent: true },
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

  private async resolveStateChamber(
    state: string,
    chamber: 'lower' | 'upper',
    district: string | null,
  ): Promise<StateLegislatorSummary | null> {
    if (!district) return null;
    const target = normalizeDistrictCode(district);
    if (!target) return null;
    const legislators = await this.prisma.stateLegislator.findMany({
      where: { state, chamber, active: true },
      select: {
        id: true,
        name: true,
        state: true,
        chamber: true,
        district: true,
        party: true,
        url: true,
      },
    });
    return legislators.find((l) => normalizeDistrictCode(l.district) === target) ?? null;
  }
}

/**
 * "00" (the facility at-large sentinel) matches a stored `district === null`
 * — at-large House members are stored with `district = NULL`, NOT 0
 * (`sync-congress-members.ts:188`). A naive `Number('00') === district`
 * join silently returns no representative for the 6 at-large states (WY, VT,
 * DE, ND, SD, AK) — this is the exact bug PD1.3/M1.3 calls out.
 *
 * Implementation moved to `common/district-code.util.ts` (§7-A1); re-exported
 * here because this module is the documented source of truth for the facility
 * rail and several callers import it from this path.
 */
export { districtMatchesHouse };
