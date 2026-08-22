/**
 * District Nexus Release 2 — Strategic Relevance weight definition.
 *
 * Single versioned source of truth for component weights. Test weights from
 * Capiro_District_Nexus_Deployment_Plan.md §7.1 — NOT empirically validated.
 * Tune only by editing this file (or a future config row that loads into the
 * same shape); never scatter literals through scorers or services.
 */

export const STRATEGIC_SCORE_VERSION = 'strategic-relevance-v1-test';

/** Coverage floor (% of total weight with determinate evidence). Below this → score null. */
export const STRATEGIC_DEFAULT_MIN_COVERAGE_PERCENT = 20;

export const STRATEGIC_COMPONENTS = [
  'committeeJurisdiction',
  'programElementBudget',
  'activeLegislation',
  'activeStrategyTarget',
  'relationshipEngagement',
  'hearingTiming',
  'opportunityFunding',
  'memberHistoricalPriorities',
] as const;

export type StrategicComponentKey = (typeof STRATEGIC_COMPONENTS)[number];

/**
 * Initial test weights (sum = 100). Plan §7.1.
 * memberHistoricalPriorities (CPF/CDS) is defined but may be unavailable until
 * a structured source exists — unavailability is coverage gap, not zero.
 */
export const STRATEGIC_COMPONENT_WEIGHTS: Readonly<Record<StrategicComponentKey, number>> =
  Object.freeze({
    committeeJurisdiction: 25,
    programElementBudget: 20,
    activeLegislation: 15,
    activeStrategyTarget: 15,
    relationshipEngagement: 10,
    hearingTiming: 5,
    opportunityFunding: 5,
    memberHistoricalPriorities: 5,
  });

export const STRATEGIC_COMPONENT_LABELS: Readonly<Record<StrategicComponentKey, string>> =
  Object.freeze({
    committeeJurisdiction: 'Committee / subcommittee jurisdiction',
    programElementBudget: 'Program Element / budget relevance',
    activeLegislation: 'Active legislation relevance',
    activeStrategyTarget: 'Active strategy / tactic target',
    relationshipEngagement: 'Relationship / engagement context',
    hearingTiming: 'Hearing / regulatory timing',
    opportunityFunding: 'Opportunity / funding relevance',
    memberHistoricalPriorities: 'Member historical priorities',
  });

/** Canonical defense budget committee system codes used for PE jurisdiction. */
export const DEFENSE_BUDGET_COMMITTEE_CODES = Object.freeze({
  /** House Armed Services */
  HASC: 'hsas00',
  /** Senate Armed Services */
  SASC: 'ssas00',
  /** House Appropriations (parent — Defense sub is scored via membership on parent or known sub) */
  HAC: 'hsap00',
  /** Senate Appropriations */
  SAC: 'ssap00',
} as const);

/**
 * PE budget stage → committee system codes that can claim jurisdiction credit
 * when the member sits on the committee AND the client has PE relevance.
 * Structured only — never inferred from committee display names in the scorer.
 */
export const PE_STAGE_COMMITTEE_CODES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  hasc: [DEFENSE_BUDGET_COMMITTEE_CODES.HASC],
  sasc: [DEFENSE_BUDGET_COMMITTEE_CODES.SASC],
  hac_d: [DEFENSE_BUDGET_COMMITTEE_CODES.HAC],
  sac_d: [DEFENSE_BUDGET_COMMITTEE_CODES.SAC],
  request: [
    DEFENSE_BUDGET_COMMITTEE_CODES.HASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.HAC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SAC,
  ],
  conference: [
    DEFENSE_BUDGET_COMMITTEE_CODES.HASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.HAC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SAC,
  ],
  enacted: [
    DEFENSE_BUDGET_COMMITTEE_CODES.HASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SASC,
    DEFENSE_BUDGET_COMMITTEE_CODES.HAC,
    DEFENSE_BUDGET_COMMITTEE_CODES.SAC,
  ],
});

export function strategicWeightTotal(): number {
  return STRATEGIC_COMPONENTS.reduce((sum, key) => sum + STRATEGIC_COMPONENT_WEIGHTS[key], 0);
}
