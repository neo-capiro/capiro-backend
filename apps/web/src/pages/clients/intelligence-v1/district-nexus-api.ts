import type { AxiosInstance } from 'axios';
import type { FacilityRepresentation, FederalMemberSummary } from './representation-api.js';

/**
 * Web API for a client's District Nexus — federal contract spend grouped by
 * congressional district (place-of-performance), with census demographics.
 *
 * Mirrors apps/api/src/intelligence/intelligence.controller.ts
 * (GET /api/intelligence/clients/:clientId/district-nexus-spend → service
 * getDistrictNexusSpend). The honest, data-driven engine: real USAspending
 * federal_award rows matched to the client via confirmed `contracting` intel
 * mappings, grouped by pop_congressional_district, joined to census_district.
 *
 * `linked: false` means no confirmed contractor mapping for this client — the UI
 * deep-links to Settings → Intelligence Mappings (source=contracting) to fix it.
 * `linked: true` with zero districts means awards are mapped but not yet enriched
 * with a congressional district (enrichment runs incrementally).
 */

export interface DistrictDemographics {
  totalPopulation: number | null;
  medianHouseholdIncome: number | null;
  laborForceSize: number | null;
  unemploymentRate: number | null;
  percentVeteran: number | null;
  dataYear: number;
}

/**
 * Current federal representative(s) for this spend district. "Current" — the
 * district may reflect the map in effect when the award was recorded
 * (redistricting vintage skew), so this is NOT a claim the shown member held
 * the seat at award time. `house` is null when the seat can't be determined
 * (non-voting delegate / multiple-or-undefined district sentinel), never a
 * guess. Independent of the facility-based "Your representatives" block
 * above (representation-api.ts) — a client can have spend in a district with
 * no facility there.
 */
export interface DistrictNexusRepresentatives {
  house: FederalMemberSummary | null;
  senate: FederalMemberSummary[];
}

export interface DistrictNexusRow {
  district: string; // e.g. "TX-23"
  state: string;
  districtNumber: string;
  awardCount: number;
  totalAmount: number;
  demographics: DistrictDemographics | null;
  representatives: DistrictNexusRepresentatives;
}

export interface DistrictNexusUnlinked {
  linked: false;
  reason: string;
  contractorNames: string[];
  totalAwards: number;
  totalAmount: number;
  districts: [];
  unmappedAmount: number;
  disclaimer: string;
}

export interface DistrictNexusLinked {
  linked: true;
  contractorNames: string[];
  totalAwards: number;
  totalAmount: number;
  districtCount: number;
  unmappedAmount: number;
  districts: DistrictNexusRow[];
  disclaimer: string;
}

export type DistrictNexus = DistrictNexusLinked | DistrictNexusUnlinked;

export async function getClientDistrictNexus(
  api: AxiosInstance,
  clientId: string,
): Promise<DistrictNexus> {
  return (
    await api.get<DistrictNexus>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-spend`,
    )
  ).data;
}

// ── District Nexus v2 (WS-H1) ───────────────────────────────────────────────
//
// Mirrors apps/api/src/district-nexus/district-nexus.types.ts
// `ClientDistrictNexusResponse`. The shared sub-types are imported TYPE-ONLY
// from the map feature's own mirror rather than re-declared here — they are
// already mirrored once, and a second hand-copy is a second thing to drift.
// Type-only, so nothing from that folder reaches this chunk at runtime.
import type {
  AwardedFunding,
  ClientOpportunity,
  ClientOpportunitySummary,
  DataQualityWarning,
  DistrictKey,
  DistrictNexusDistrictDetail,
  IsoTimestamp,
  Money,
  NexusScoreBreakdown,
  OpportunityEligibilityState,
  OpportunityFunding,
  SourceFreshness,
  UnmappedFunding,
} from '../../intelligence/district-nexus/district-nexus-api.js';

export type {
  AwardedFunding,
  ClientOpportunity,
  ClientOpportunitySummary,
  DistrictNexusDistrictDetail,
  Money,
  NexusScoreBreakdown,
  OpportunityEligibilityState,
  SourceFreshness,
};

export interface ClientNexusLinkage {
  contractingLinked: boolean;
  contractorNames: string[];
  assistanceLinked: boolean;
  recipientNames: string[];
  ueiConfirmedCount: number;
}

export interface ClientFacilityFootprint {
  facilityCount: number;
  facilitiesWithoutDistrict: number;
  /** null = no facility reported a headcount. NEVER render as 0. */
  employeeCount: number | null;
  facilitiesMissingEmployeeCount: number;
}

export interface ClientDistrictNexusV2 {
  clientId: string;
  districts: DistrictNexusDistrictDetail[];
  representativesByFacility: FacilityRepresentation[];
  linkage: ClientNexusLinkage;
  facilityFootprint: ClientFacilityFootprint;
  awarded: AwardedFunding;
  /**
   * District-derived only: populated when an opportunity was explicitly linked
   * to a project-site facility that resolved to a district (see
   * aggregateOpportunitySummary). Most opportunities have no such link, so
   * this is usually {null, null} — the client's OWN full pipeline, never
   * dropped for lack of geography, is `opportunitySummary` below.
   */
  opportunities: OpportunityFunding;
  /** The client's own opportunity pipeline (WS-F) — see `ClientOpportunitySummary`. */
  opportunitySummary: ClientOpportunitySummary;
  unmapped: UnmappedFunding;
  score: number | null;
  bestDistrictKey: DistrictKey | null;
  coveragePercent: number;
  breakdown: NexusScoreBreakdown[];
  strongestDrivers: NexusScoreBreakdown[];
  freshness: SourceFreshness[];
  warnings: DataQualityWarning[];
  generatedAt: IsoTimestamp;
}

export async function getClientDistrictNexusV2(
  api: AxiosInstance,
  clientId: string,
): Promise<ClientDistrictNexusV2> {
  return (
    await api.get<ClientDistrictNexusV2>(
      `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2`,
    )
  ).data;
}
