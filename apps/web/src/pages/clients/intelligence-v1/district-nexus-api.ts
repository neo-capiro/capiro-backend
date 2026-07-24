import type { AxiosInstance } from 'axios';
import type { FederalMemberSummary } from './representation-api.js';

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
