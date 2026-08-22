/**
 * District Nexus Release 2 — deterministic gap analysis (pure).
 *
 * Named gap types only. Does not collapse into one quadrant.
 * Distinguishes "low" from "missing/incomplete".
 */

import type {
  ClientDistrictStrategicGapsResponse,
  StrategicGapFinding,
  StrategicGapType,
  StrategicRelevanceScore,
} from './district-nexus-strategic.types.js';
import { STRATEGIC_SCORE_VERSION } from './district-nexus-strategic-weights.js';

export const STRATEGIC_GAP_RULE_VERSION = 'strategic-gaps-v1';

export const STRATEGIC_GAP_THRESHOLDS = Object.freeze({
  highStrategic: 60,
  lowNexus: 25,
  highNexus: 60,
  /** Engagement component credit at or below this counts as "low engagement". */
  lowEngagementCredit: 2,
});

export interface DistrictGapInput {
  districtKey: string;
  state: string;
  district: string;
  strategic: StrategicRelevanceScore;
  nexusScore: number | null;
  nexusCoveragePercent: number | null;
  /** True when facility/award boundary vintage conflicts with current session. */
  geographyVintageConflict?: boolean;
}

function emptyCounts(): Record<StrategicGapType, number> {
  return {
    high_strategic_low_nexus: 0,
    high_nexus_low_engagement: 0,
    strong_footprint_no_active_strategy: 0,
    committee_appropriations_weak_relationship: 0,
    relevant_pe_no_target_engagement: 0,
    incomplete_strategic_evidence: 0,
    geography_vintage_conflict: 0,
  };
}

function creditOf(
  strategic: StrategicRelevanceScore,
  component: string,
): number | null {
  const row = strategic.breakdown.find((b) => b.component === component);
  if (!row) return null;
  if (row.status === 'missing' || row.status === 'unavailable') return null;
  return row.credit;
}

function labelFor(gapType: StrategicGapType): string {
  switch (gapType) {
    case 'high_strategic_low_nexus':
      return 'High strategic relevance + low nexus';
    case 'high_nexus_low_engagement':
      return 'High nexus + low engagement';
    case 'strong_footprint_no_active_strategy':
      return 'Strong footprint + no active strategy';
    case 'committee_appropriations_weak_relationship':
      return 'Committee / appropriations relevance + weak relationship';
    case 'relevant_pe_no_target_engagement':
      return 'Relevant PE + no target / engagement';
    case 'incomplete_strategic_evidence':
      return 'Incomplete strategic evidence';
    case 'geography_vintage_conflict':
      return 'Geography vintage conflict';
    default:
      return gapType;
  }
}

/**
 * Classify gaps for one district. Returns zero or more named findings.
 * Incomplete evidence is never labeled "low strategic".
 */
export function classifyDistrictGaps(input: DistrictGapInput): StrategicGapFinding[] {
  const { strategic, nexusScore, districtKey, state, district } = input;
  const t = STRATEGIC_GAP_THRESHOLDS;
  const findings: StrategicGapFinding[] = [];
  const engagementCredit = creditOf(strategic, 'relationshipEngagement');
  const strategyCredit = creditOf(strategic, 'activeStrategyTarget');
  const committeeCredit = creditOf(strategic, 'committeeJurisdiction');
  const peCredit = creditOf(strategic, 'programElementBudget');

  const push = (
    gapType: StrategicGapType,
    evidence: string[],
  ) => {
    findings.push({
      gapType,
      label: labelFor(gapType),
      districtKey,
      state,
      district,
      evidence,
      ruleVersion: STRATEGIC_GAP_RULE_VERSION,
      strategicScore: strategic.score,
      nexusScore,
      engagementCredit,
      strategyCredit,
    });
  };

  // Incomplete first — distinct from low.
  if (
    strategic.score == null ||
    strategic.missingComponents.length + strategic.unavailableComponents.length >= 3
  ) {
    push('incomplete_strategic_evidence', [
      strategic.score == null
        ? `Strategic score unscored (coverage ${strategic.coveragePercent}% < floor ${strategic.minCoveragePercent}%).`
        : `Multiple strategic components missing/unavailable (${strategic.missingComponents.length + strategic.unavailableComponents.length}).`,
      ...strategic.missingComponents.map((c) => `missing:${c}`),
      ...strategic.unavailableComponents.map((c) => `unavailable:${c}`),
    ]);
  }

  if (
    strategic.score != null &&
    strategic.score >= t.highStrategic &&
    (nexusScore == null || nexusScore < t.lowNexus)
  ) {
    push('high_strategic_low_nexus', [
      `Strategic score ${strategic.score} ≥ ${t.highStrategic}.`,
      nexusScore == null
        ? 'Nexus Strength unscored or absent.'
        : `Nexus Strength ${nexusScore} < ${t.lowNexus}.`,
    ]);
  }

  if (
    nexusScore != null &&
    nexusScore >= t.highNexus &&
    (engagementCredit == null || engagementCredit <= t.lowEngagementCredit)
  ) {
    push('high_nexus_low_engagement', [
      `Nexus Strength ${nexusScore} ≥ ${t.highNexus}.`,
      engagementCredit == null
        ? 'Engagement component missing (not low — unmeasured).'
        : `Engagement credit ${engagementCredit} ≤ ${t.lowEngagementCredit}.`,
    ]);
  }

  if (
    nexusScore != null &&
    nexusScore >= t.highNexus &&
    (strategyCredit == null || strategyCredit === 0)
  ) {
    push('strong_footprint_no_active_strategy', [
      `Nexus Strength ${nexusScore} ≥ ${t.highNexus}.`,
      strategyCredit == null
        ? 'No structured strategy/tactic target for this member/district.'
        : 'Strategy component scored but earned no credit.',
    ]);
  }

  if (
    committeeCredit != null &&
    committeeCredit > 0 &&
    (engagementCredit == null || engagementCredit <= t.lowEngagementCredit)
  ) {
    push('committee_appropriations_weak_relationship', [
      `Committee jurisdiction credit ${committeeCredit}.`,
      engagementCredit == null
        ? 'Relationship/engagement unmeasured.'
        : `Relationship credit ${engagementCredit} ≤ ${t.lowEngagementCredit}.`,
    ]);
  }

  if (
    peCredit != null &&
    peCredit > 0 &&
    (engagementCredit == null || engagementCredit <= 0) &&
    (strategyCredit == null || strategyCredit <= 0)
  ) {
    push('relevant_pe_no_target_engagement', [
      `Program Element credit ${peCredit}.`,
      'No structured client target or engagement with the district office.',
    ]);
  }

  if (input.geographyVintageConflict) {
    push('geography_vintage_conflict', [
      'Facility or award geography vintage conflicts with the current congressional session.',
    ]);
  }

  return findings;
}

export function buildGapsResponse(args: {
  clientId: string;
  clientName: string | null;
  districts: DistrictGapInput[];
  computedAt?: string;
}): ClientDistrictStrategicGapsResponse {
  const gaps: StrategicGapFinding[] = [];
  for (const d of args.districts) {
    gaps.push(...classifyDistrictGaps(d));
  }
  const counts = emptyCounts();
  for (const g of gaps) counts[g.gapType] += 1;

  return {
    clientId: args.clientId,
    clientName: args.clientName,
    ruleVersion: STRATEGIC_GAP_RULE_VERSION,
    scoreVersion: STRATEGIC_SCORE_VERSION,
    thresholds: { ...STRATEGIC_GAP_THRESHOLDS },
    computedAt: args.computedAt ?? new Date().toISOString(),
    gaps,
    counts,
  };
}
