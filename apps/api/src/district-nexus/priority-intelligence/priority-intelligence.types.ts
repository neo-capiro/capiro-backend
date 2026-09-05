/**
 * District Nexus Release 4 — Priority Intelligence response contracts.
 *
 * Integrated into the EXISTING District Nexus API surface (same controller
 * prefix, same guard chain) — never a parallel module or map. The three first-
 * class outputs (nexusStrength / strategicRelevance / dataCoverage) are echoed
 * from their existing release owners; Release 4 never computes or blends them.
 */

import type { IsoTimestamp } from '../district-nexus.types.js';
import type {
  ProjectedCpfCdsSignal,
  CommunityFundingAvailability,
  MemberPrioritySummary,
} from './priority-intelligence-cpf-cds.js';
import type {
  SectorMetricProjection,
  SectorSignalAvailability,
} from './priority-intelligence-sector.js';
import type { DistrictNexusChangeSeverity } from './priority-intelligence-change-policy.js';

export const DISTRICT_NEXUS_PRIORITY_INTELLIGENCE_FEATURE = 'district_nexus_priority_intelligence';

export interface PriorityIntelligenceAvailability {
  status: 'loaded' | 'not_loaded' | 'stale' | 'error';
  /** Human-auditable reason; 'not_loaded' is distinct from empty. */
  reason: string | null;
  lastSuccessAt: IsoTimestamp | null;
  lastFailureAt: IsoTimestamp | null;
  lastError: string | null;
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
  /** Totals count ONLY detailed_asset rows; summarized rows are listed separately. */
  detailedAssetCount: number | null;
  detailedSquareFeetTotal: number | null;
  summarizedInstallationCount: number | null;
  ownedCount: number | null;
  leasedCount: number | null;
  /** Agencies by asset count (top 8), detailed grain only. */
  agenciesByAssetCount: Array<{ agency: string; assetCount: number }>;
  topAssets: GsaPropertySummary[];
  /** FYs present for this district. */
  fiscalYears: number[];
  warnings: string[];
}

export interface SectorSignalsRail {
  availability: SectorSignalAvailability;
  /** Deterministically mapped public metrics — public context, never client data. */
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
  severity: DistrictNexusChangeSeverity;
  provenance: Record<string, unknown>;
}

export interface PriorityIntelligenceFreshnessEntry {
  rail: 'cpf_cds' | 'gsa' | 'sector_cbp' | 'sector_acs' | 'sector_lodes' | 'changes';
  status: 'current' | 'stale' | 'not_loaded' | 'failed';
  sourceYear: number | null;
  lastSuccessAt: IsoTimestamp | null;
  lastAttemptAt: IsoTimestamp | null;
  /** True when the rail's data is stale per the central policy — rendered visibly. */
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
    /** Label such as "R-AL-2 · statewide" for UI display. */
    representation: string;
  };

  /** Echoed from existing Release 1/2 owners — NOT recomputed here. */
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
  /** Coverage of the evidence supporting the two scores above. */
  dataCoverage: {
    coveragePercent: number | null;
    missingInputs: string[];
  } | null;

  priorityIntelligence: {
    cpfCds: {
      availability: CommunityFundingAvailability;
      /** Requests attributed to THIS district (house) or state (senate statewide, labeled). */
      districtRequests: ProjectedCpfCdsSignal[];
      /** Requests deterministically linked to the CLIENT via reviewed relationships. */
      clientRequests: ProjectedCpfCdsSignal[];
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
    /** District boundary Congress the response is expressed against, when known. */
    boundaryCongress: number | null;
    /** Non-null when sources disagree on vintage — rendered as a conflict. */
    conflict: boolean;
    detail: string | null;
  };
  warnings: string[];
  computedAt: IsoTimestamp;
}
