/**
 * District Nexus Release 2 — Strategic Relevance response contracts.
 *
 * Separate from Nexus Strength (district-nexus.types.ts). Never blend scores.
 * Money/award fields do not live here — strategic context must not alter award truth.
 */

import type { IsoTimestamp, SourceFreshness } from './district-nexus.types.js';
import type { StrategicComponentKey } from './district-nexus-strategic-weights.js';

export type { StrategicComponentKey };

/** How a strategic component was measured for this district. */
export type StrategicComponentStatus =
  /** Structured evidence earned credit (may be partial). */
  | 'scored'
  /** Rail was queried; no structured link for this district — credit stays absent, not zero. */
  | 'missing'
  /** Rail cannot be evaluated with current schema/sources (coverage gap). */
  | 'unavailable'
  /** Evidence exists but is stale enough to warn; still may carry reduced credit. */
  | 'stale';

export interface StrategicScoreBreakdown {
  component: StrategicComponentKey;
  label: string;
  weight: number;
  /**
   * Actual contribution. Null when the component is missing/unavailable —
   * NEVER coerced to 0 (null ≠ zero).
   */
  credit: number | null;
  status: StrategicComponentStatus;
  rationale: string;
  evidenceCount: number;
}

export interface StrategicEvidence {
  component: StrategicComponentKey;
  sourceType: string;
  label: string;
  sourceRecordId: string | null;
  observedAt: IsoTimestamp | null;
  /** Minimum structured fact — never private meeting notes. */
  summary: string;
  /** Optional structured payload for drill-down (ids only, no confidential body). */
  refs?: Record<string, string | number | boolean | null>;
}

export interface StrategicConflictWarning {
  code:
    | 'stale_source'
    | 'geography_vintage_conflict'
    | 'incomplete_strategic_evidence'
    | 'inferred_link_excluded'
    | 'private_engagement_redacted'
    | 'component_unavailable';
  message: string;
  component?: StrategicComponentKey;
}

export interface StrategicRelevanceScore {
  /** 0-100 whole number, or null when coverage is below the floor. */
  score: number | null;
  coveragePercent: number;
  breakdown: StrategicScoreBreakdown[];
  evidence: StrategicEvidence[];
  missingComponents: StrategicComponentKey[];
  unavailableComponents: StrategicComponentKey[];
  strongestDrivers: StrategicScoreBreakdown[];
  freshness: SourceFreshness[];
  conflicts: StrategicConflictWarning[];
  scoreVersion: string;
  weightsVersion: string;
  minCoveragePercent: number;
  computedAt: IsoTimestamp;
}

export interface DistrictStrategicRelevanceResponse {
  districtKey: string;
  state: string;
  district: string;
  clientId: string;
  clientName: string | null;
  /** Member bioguides representing this district (house + senate) used for links. */
  memberBioguides: string[];
  strategic: StrategicRelevanceScore;
  /**
   * Nexus Strength from Release 1 for the same district+client when available.
   * Surfaced for gap analysis / dual display — never mixed into strategic.score.
   */
  nexusStrength: {
    score: number | null;
    coveragePercent: number;
  } | null;
  /** Feature flag state for the strategic module (always true when this payload returns). */
  strategicEnabled: true;
}

export interface ClientDistrictStrategicMapResponse {
  clientId: string;
  clientName: string | null;
  scoreVersion: string;
  weightsVersion: string;
  minCoveragePercent: number;
  computedAt: IsoTimestamp;
  districts: Array<{
    districtKey: string;
    state: string;
    district: string;
    strategicScore: number | null;
    strategicCoveragePercent: number;
    strongestDrivers: string[];
    missingComponents: StrategicComponentKey[];
    nexusScore: number | null;
    nexusCoveragePercent: number | null;
  }>;
  /** Districts with incomplete strategic evidence (coverage below floor or missing components). */
  incompleteCount: number;
}

export type StrategicGapType =
  | 'high_strategic_low_nexus'
  | 'high_nexus_low_engagement'
  | 'strong_footprint_no_active_strategy'
  | 'committee_appropriations_weak_relationship'
  | 'relevant_pe_no_target_engagement'
  | 'incomplete_strategic_evidence'
  | 'geography_vintage_conflict';

export interface StrategicGapFinding {
  gapType: StrategicGapType;
  label: string;
  districtKey: string;
  state: string;
  district: string;
  evidence: string[];
  /** Thresholds / version that produced this classification. */
  ruleVersion: string;
  strategicScore: number | null;
  nexusScore: number | null;
  engagementCredit: number | null;
  strategyCredit: number | null;
}

export interface ClientDistrictStrategicGapsResponse {
  clientId: string;
  clientName: string | null;
  ruleVersion: string;
  scoreVersion: string;
  thresholds: {
    highStrategic: number;
    lowNexus: number;
    highNexus: number;
    lowEngagementCredit: number;
  };
  computedAt: IsoTimestamp;
  gaps: StrategicGapFinding[];
  /** Counts by gap type (missing ≠ low — incomplete_strategic_evidence is separate). */
  counts: Record<StrategicGapType, number>;
}
