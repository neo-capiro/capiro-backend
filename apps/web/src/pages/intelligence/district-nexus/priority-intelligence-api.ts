import type { AxiosInstance } from 'axios';

/**
 * District Nexus Release 4 — Priority Intelligence web-side type mirror.
 *
 * Mirrors apps/api/src/district-nexus/priority-intelligence/priority-intelligence.types.ts.
 * Honesty contracts preserved: null is never zero; unavailable is never empty;
 * stale is rendered stale; requested vs final amounts are separately labeled;
 * source and year travel with every figure.
 */

export const DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE = 'district_nexus_priority_intelligence';

export type IsoTimestamp = string;

export interface PriorityIntelligenceAvailability {
  status: 'loaded' | 'not_loaded' | 'stale' | 'error';
  reason: string | null;
  lastSuccessAt: IsoTimestamp | null;
  lastFailureAt: IsoTimestamp | null;
  lastError: string | null;
}

export interface CpfCdsOccurrence {
  sourceDocumentId: string;
  sourcePage: number | null;
  sourceRow: number;
  requesterNameRaw: string;
  amountStageRaw: string;
  requestedAmountUsd: string;
  finalAmountUsd: string | null;
  retrievedAt: IsoTimestamp;
}

export interface CpfCdsGeographyAttribution {
  basis: 'house_district' | 'senate_statewide' | 'senate_project_district' | 'unresolved';
  state?: string;
  district?: string;
  reason?: string;
}

export interface CpfCdsRequestSignal {
  requestId: string;
  chamber: 'house' | 'senate';
  requestType: 'cpf' | 'cds';
  fiscalYear: number;
  requesterName: string;
  recipientName: string;
  projectTitle: string;
  districtKey: string | null;
  geography: CpfCdsGeographyAttribution;
  requestedAmountUsd: number;
  finalAmountUsd: number | null;
  amountStageRaw: string;
  appropriationsAccountRaw: string | null;
  sourceOccurrenceCount: number;
  occurrences: CpfCdsOccurrence[];
  clientAttribution: {
    method: 'confirmed_client_intel_mapping' | 'exact_recipient_normalized' | 'exact_alias';
    evidenceId: string | null;
  } | null;
}

export interface CommunityFundingAvailability {
  status: 'unavailable' | 'loaded';
  reason: string | null;
  lastIngestRunAt: IsoTimestamp | null;
  loadedFiscalYears: number[];
}

export interface MemberPrioritySummary {
  bioguideId: string;
  memberName?: string;
  /** Older API responses did not establish individual requester identity. */
  attributionMethod?: 'source_requester_name';
  chamber: 'house' | 'senate';
  state: string | null;
  fiscalYears: number[];
  requestedTotalUsd: number;
  finalTotalUsd: number;
  includesStatewideAttribution: boolean;
}

export interface GsaPropertySummary {
  rpUid: string;
  reportingAgency: string;
  usingAgency: string | null;
  installationName: string | null;
  legalInterest: string | null;
  realPropertyType: string | null;
  realPropertyUse: string | null;
  assetStatus: string | null;
  squareFeet: number | null;
  squareFeetUom: string | null;
  city: string | null;
  state: string | null;
  congressionalDistrict: string | null;
  boundaryCongress: number | null;
  isDefense: boolean;
  grain: 'detailed_asset' | 'summarized_installation';
  sourceDataset: string;
  fiscalYear: number;
  sourceUrl: string | null;
  geographyBasis: 'source_coordinates' | 'source_state_only' | 'unresolved';
}

export interface GsaFederalPresence {
  availability: PriorityIntelligenceAvailability;
  detailedAssetCount: number | null;
  detailedSquareFeetTotal: number | null;
  summarizedInstallationCount: number | null;
  ownedCount: number | null;
  leasedCount: number | null;
  agenciesByAssetCount: Array<{ agency: string; assetCount: number }>;
  topAssets: GsaPropertySummary[];
  fiscalYears: number[];
  /** All source boundary values in the latest FY aggregate; null means unknown.
   * Optional while older API images are still serving during a rollout. */
  boundaryCongresses?: Array<number | null>;
  warnings: string[];
}

export interface SectorMetricProjection {
  family: 'manufacturing_industry' | 'workforce' | 'defense_federal_presence';
  label: string;
  source: 'cbp' | 'lodes' | 'acs' | 'gsa' | 'federal_awards' | 'program_element';
  dataset: string;
  sourceYear: number | null;
  boundaryCongress: number | null;
  naicsCode: string | null;
  metricKey: string;
  metricValue: number | null;
  unit: string | null;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
  lastSyncedAt: string | null;
}

export interface SectorSignalAvailability {
  status: 'loaded' | 'not_loaded' | 'stale';
  sources: Array<{
    source: string;
    dataset: string;
    sourceYear: number | null;
    lastSyncedAt: string | null;
    lastRunStatus:
      | 'success'
      | 'success_with_errors'
      | 'failed'
      | 'unavailable'
      | 'running'
      | 'no_run'
      | null;
  }>;
}

export interface SectorSignalsRail {
  availability: SectorSignalAvailability;
  metrics: SectorMetricProjection[];
  warnings: string[];
}

export interface RecentChangeRecord {
  changeKind: string;
  source: string;
  sourceRecordId: string;
  state: string | null;
  district: string | null;
  boundaryCongress: number | null;
  oldValue: unknown;
  newValue: unknown;
  oldState: string | null;
  newState: string | null;
  observedAt: IsoTimestamp;
  effectiveAt: IsoTimestamp | null;
  sourceYear: number | null;
  geographyVintage: string | null;
  severity: 'info' | 'notable' | 'material';
  provenance: Record<string, unknown>;
}

export interface PriorityIntelligenceFreshnessEntry {
  rail: string;
  status: 'current' | 'stale' | 'not_loaded' | 'failed';
  sourceYear: number | null;
  lastSuccessAt: IsoTimestamp | null;
  lastAttemptAt: IsoTimestamp | null;
  stale: boolean;
}

export interface ClientPriorityIntelligenceResponse {
  clientId: string;
  clientName: string;
  districtKey: string;
  state: string;
  district: string;
  member: {
    houseMemberBioguideIds: string[];
    senatorBioguideIds: string[];
    representation: string;
  };
  nexusStrength: {
    score: number | null;
    coveragePercent: number | null;
    scoreVersion: string;
  } | null;
  strategicRelevance: {
    score: number | null;
    coveragePercent: number | null;
    scoreVersion: string;
  } | null;
  dataCoverage: {
    coveragePercent: number | null;
    missingInputs: string[];
  } | null;
  priorityIntelligence: {
    cpfCds: {
      availability: CommunityFundingAvailability;
      districtRequests: CpfCdsRequestSignal[];
      clientRequests: CpfCdsRequestSignal[];
      memberHistoricalPriorities: MemberPrioritySummary[];
      warnings: string[];
    };
    federalProperty: GsaFederalPresence;
    sectorSignals: SectorSignalsRail;
    recentChanges: RecentChangeRecord[];
  };
  strongestPrioritySignals: string[];
  missingPrioritySources: string[];
  freshness: PriorityIntelligenceFreshnessEntry[];
  geographyVintage: {
    boundaryCongress: number | null;
    conflict: boolean;
    detail: string | null;
  };
  warnings: string[];
  computedAt: IsoTimestamp;
}

/**
 * Fetch one district's priority intelligence for a client. 404 = feature/flag
 * not enabled for this tenant (fail-closed; rendered as "not enabled", not as
 * an empty rail). Requires ?state=&district= query params.
 */
export async function getClientDistrictPriorityIntelligence(
  api: AxiosInstance,
  clientId: string,
  state: string,
  district: string,
): Promise<ClientPriorityIntelligenceResponse> {
  const params = new URLSearchParams({ state, district });
  const res = await api.get<ClientPriorityIntelligenceResponse>(
    `/api/intelligence/clients/${encodeURIComponent(clientId)}/district-nexus-v2/priority-intelligence?${params.toString()}`,
  );
  return res.data;
}
