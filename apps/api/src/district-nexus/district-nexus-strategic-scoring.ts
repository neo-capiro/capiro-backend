/**
 * District Nexus Release 2 — pure Strategic Relevance scorer.
 *
 * No I/O, no Prisma, no LLM. The service gathers structured evidence facts and
 * calls in here. Mirrors district-nexus-scoring.ts discipline:
 *   - missing component ≠ zero
 *   - low coverage ⇒ score null
 *   - component credit is exact; only the final score rounds
 *   - never blends Nexus Strength
 */

import type {
  StrategicConflictWarning,
  StrategicEvidence,
  StrategicRelevanceScore,
  StrategicScoreBreakdown,
  StrategicComponentStatus,
} from './district-nexus-strategic.types.js';
import {
  STRATEGIC_COMPONENTS,
  STRATEGIC_COMPONENT_LABELS,
  STRATEGIC_COMPONENT_WEIGHTS,
  STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT,
  STRATEGIC_SCORE_VERSION,
  type StrategicComponentKey,
  strategicWeightTotal,
} from './district-nexus-strategic-weights.js';

export type StrategicEvidenceStrength =
  | 'verified'
  | 'sourceAuthoritative'
  | 'partial'
  | 'absent'
  | 'unavailable';

const STRENGTH_MULTIPLIER: Readonly<Record<StrategicEvidenceStrength, number>> = Object.freeze({
  verified: 1,
  sourceAuthoritative: 1,
  /** Structured but weaker link (e.g. cosponsor vs sponsor, older engagement). */
  partial: 0.5,
  absent: 0,
  unavailable: 0,
});

export interface StrategicComponentInput {
  strength: StrategicEvidenceStrength;
  evidenceCount?: number;
  rationale?: string;
  evidence?: StrategicEvidence[];
}

export interface StrategicScoreInput {
  components: Partial<Record<StrategicComponentKey, StrategicComponentInput>>;
  freshness?: StrategicRelevanceScore['freshness'];
  conflicts?: StrategicConflictWarning[];
  minCoveragePercent?: number;
  computedAt?: string;
}

function statusFor(strength: StrategicEvidenceStrength): StrategicComponentStatus {
  if (strength === 'unavailable') return 'unavailable';
  if (strength === 'absent') return 'missing';
  return 'scored';
}

function defaultRationale(key: StrategicComponentKey, strength: StrategicEvidenceStrength): string {
  switch (strength) {
    case 'verified':
    case 'sourceAuthoritative':
      return 'Structured evidence supports full component credit.';
    case 'partial':
      return 'Structured evidence supports partial component credit.';
    case 'unavailable':
      return 'Component cannot be evaluated with current structured sources.';
    case 'absent':
    default:
      return `No structured ${STRATEGIC_COMPONENT_LABELS[key].toLowerCase()} evidence for this district.`;
  }
}

/**
 * Score strategic relevance from per-component evidence strength.
 *
 * Components omitted from the input are treated as `absent` (missing), not zero.
 * Components marked `unavailable` reduce coverage the same way as missing —
 * they do not invent a low score.
 */
export function scoreStrategicRelevance(input: StrategicScoreInput): StrategicRelevanceScore {
  const minCoverage = input.minCoveragePercent ?? STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT;
  const totalWeight = strategicWeightTotal();
  const breakdown: StrategicScoreBreakdown[] = [];
  const evidence: StrategicEvidence[] = [];
  let coveredWeight = 0;
  let earnedCredit = 0;

  for (const key of STRATEGIC_COMPONENTS) {
    const weight = STRATEGIC_COMPONENT_WEIGHTS[key];
    const component = input.components[key];
    const strength: StrategicEvidenceStrength = component?.strength ?? 'absent';
    const status = statusFor(strength);
    const multiplier = STRENGTH_MULTIPLIER[strength];
    const hasDeterminate =
      strength === 'verified' ||
      strength === 'sourceAuthoritative' ||
      strength === 'partial';

    let credit: number | null = null;
    if (hasDeterminate) {
      credit = weight * multiplier;
      coveredWeight += weight;
      earnedCredit += credit;
    }
    // unavailable and absent: credit stays null; coverage does not include them

    breakdown.push({
      component: key,
      label: STRATEGIC_COMPONENT_LABELS[key],
      weight,
      credit,
      status,
      rationale: component?.rationale ?? defaultRationale(key, strength),
      evidenceCount: component?.evidenceCount ?? component?.evidence?.length ?? 0,
    });

    if (component?.evidence?.length) {
      for (const row of component.evidence) {
        evidence.push(row);
      }
    }
  }

  const coveragePercent =
    totalWeight === 0 ? 0 : Math.round((coveredWeight / totalWeight) * 1000) / 10;

  const score =
    coveragePercent < minCoverage
      ? null
      : Math.round(earnedCredit);

  const scoredPositive = breakdown
    .filter((b) => b.credit != null && b.credit > 0)
    .sort((a, b) => (b.credit ?? 0) - (a.credit ?? 0));

  const missingComponents = breakdown
    .filter((b) => b.status === 'missing')
    .map((b) => b.component);

  const unavailableComponents = breakdown
    .filter((b) => b.status === 'unavailable')
    .map((b) => b.component);

  const conflicts = [...(input.conflicts ?? [])];
  if (missingComponents.length > 0 || unavailableComponents.length > 0) {
    conflicts.push({
      code: 'incomplete_strategic_evidence',
      message: `Strategic evidence incomplete: ${missingComponents.length} missing, ${unavailableComponents.length} unavailable component(s).`,
    });
  }

  return {
    score,
    coveragePercent,
    breakdown,
    evidence,
    missingComponents,
    unavailableComponents,
    strongestDrivers: scoredPositive.slice(0, 3),
    freshness: input.freshness ?? [],
    conflicts,
    scoreVersion: STRATEGIC_SCORE_VERSION,
    weightsVersion: STRATEGIC_SCORE_VERSION,
    minCoveragePercent: minCoverage,
    computedAt: input.computedAt ?? new Date().toISOString(),
  };
}

/** Sum of non-null credits — used by tests to assert exact arithmetic. */
export function sumStrategicCredits(breakdown: StrategicScoreBreakdown[]): number {
  return breakdown.reduce((sum, row) => sum + (row.credit ?? 0), 0);
}
