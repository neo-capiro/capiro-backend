/**
 * District Nexus — explainable nexus scoring (Rev 2 plan, Workstream F).
 *
 * Pure functions, no I/O, no Prisma, no LLM. WS-E's DistrictNexusService
 * gathers evidence and calls in here; this module decides only how evidence
 * becomes a number, and is unit-testable without a database.
 *
 * ── The rules this encodes, and why each one exists ─────────────────────────
 *
 * 1. Missing data is never a verified zero. A component with no evidence is
 *    omitted from the score AND lowers `coveragePercent`. Scoring absence as 0
 *    would make a client we know nothing about look identical to one we
 *    checked and found nothing for.
 *
 * 2. Only verified or source-authoritative evidence earns full weight.
 *    Inferred evidence — a name-similarity match rather than a verified
 *    identifier — earns half.
 *
 * 3. Opportunities contribute nothing to awarded-funding weight. A forecast
 *    that may never be awarded cannot manufacture a funding nexus.
 *
 * 4. Recipient location ranks below place of performance, and a statewide
 *    ("90") award can never produce a full-strength single-district score.
 *    Money that landed somewhere in the state is not evidence about one
 *    district, and the score must not pretend otherwise.
 *
 * 5. Component credit is exact; only the final score rounds. This is not a
 *    style preference — rounding each component and then summing produces a
 *    breakdown that does not add up to the score it claims to explain, which
 *    is precisely the "unexplained 84/100" the plan forbids.
 */
import type { NexusScoreBreakdown, DataQualityWarning } from './district-nexus.types.js';

// ── Components and weights ──────────────────────────────────────────────────

export const NEXUS_COMPONENTS = [
  'verifiedFacility',
  'verifiedEmployees',
  'contractPlaceOfPerformance',
  'grantPlaceOfPerformance',
  'supplierOrLocalSpend',
  'partnerBeneficiary',
  'policyCommitteeRelevance',
  'relationshipContext',
] as const;

export type NexusComponentKey = (typeof NEXUS_COMPONENTS)[number];

/**
 * Product-tunable, deliberately not magic numbers scattered through the code.
 * Values are the Rev 2 plan's Workstream F defaults and sum to exactly 100.
 *
 * Physical presence dominates on purpose: a facility in the district is the
 * least deniable form of nexus, while policy relevance and relationship
 * context are real but weak signals that should never carry a score on their
 * own.
 */
export const NEXUS_COMPONENT_WEIGHTS: Readonly<Record<NexusComponentKey, number>> = Object.freeze({
  verifiedFacility: 25,
  verifiedEmployees: 20,
  contractPlaceOfPerformance: 10,
  grantPlaceOfPerformance: 10,
  supplierOrLocalSpend: 10,
  partnerBeneficiary: 10,
  policyCommitteeRelevance: 10,
  relationshipContext: 5,
});

export const NEXUS_COMPONENT_LABELS: Readonly<Record<NexusComponentKey, string>> = Object.freeze({
  verifiedFacility: 'Verified physical facility',
  verifiedEmployees: 'Verified employee aggregate',
  contractPlaceOfPerformance: 'Contract place of performance',
  grantPlaceOfPerformance: 'Grant project / place of performance',
  supplierOrLocalSpend: 'Supplier or local spend',
  partnerBeneficiary: 'Partner / beneficiary evidence',
  policyCommitteeRelevance: 'Policy / committee relevance',
  relationshipContext: 'Relationship / target context',
});

/** The awarded-funding components, where rule 3 applies. */
const AWARDED_FUNDING_COMPONENTS: ReadonlySet<NexusComponentKey> = new Set<NexusComponentKey>([
  'contractPlaceOfPerformance',
  'grantPlaceOfPerformance',
]);

// ── Evidence strength ───────────────────────────────────────────────────────

/**
 * How much of a component's weight the backing evidence can justify.
 *
 * `statewide` and `recipientLocation` are geographic qualifiers rather than
 * quality judgements, but they behave identically to a strength reduction and
 * modelling them here keeps every discount in one auditable table.
 */
export type EvidenceStrength =
  | 'verified'
  | 'sourceAuthoritative'
  | 'inferred'
  | 'recipientLocation'
  | 'statewide'
  | 'absent';

const STRENGTH_MULTIPLIER: Readonly<Record<EvidenceStrength, number>> = Object.freeze({
  verified: 1,
  sourceAuthoritative: 1,
  /** Name-fingerprint match, not a verified identifier. */
  inferred: 0.5,
  /** Recipient's mailing location, not where the work happened. */
  recipientLocation: 0.5,
  /** Statewide "90" — real money, but not attributable to one district. */
  statewide: 0.25,
  absent: 0,
});

const STRENGTH_RATIONALE: Readonly<Record<EvidenceStrength, string>> = Object.freeze({
  verified: 'Verified evidence — full weight.',
  sourceAuthoritative: 'Source-authoritative evidence — full weight.',
  inferred: 'Inferred from a name match rather than a verified identifier — half weight.',
  recipientLocation:
    'Geography taken from recipient location rather than place of performance — half weight.',
  statewide:
    'Award geography is statewide, so it cannot be attributed to a single district — quarter weight.',
  absent: 'No evidence found for this component.',
});

export interface NexusComponentEvidence {
  strength: EvidenceStrength;
  /** How many underlying records back this component. Surfaced, never scored. */
  evidenceCount?: number;
  /**
   * True when the only backing data is grant *opportunities*. Forces zero
   * credit on awarded-funding components (rule 3).
   */
  opportunityOnly?: boolean;
}

export interface NexusScoreInput {
  components: Partial<Record<NexusComponentKey, NexusComponentEvidence>>;
  /**
   * Below this coverage the result reports `score: null` rather than a number.
   * A score built from 8% of the possible evidence is not a small score, it is
   * an unknown one. Defaults to 15%.
   */
  minCoveragePercent?: number;
}

export interface NexusScoreResult {
  /** 0-100, rounded to a whole number. Null when coverage is below the floor. */
  score: number | null;
  /** Share of total weight for which we have any determinate evidence. */
  coveragePercent: number;
  breakdown: NexusScoreBreakdown[];
  /** Highest-credit components first; components with zero credit are excluded. */
  strongestDrivers: NexusScoreBreakdown[];
  warnings: DataQualityWarning[];
}

/**
 * Exported so the API and its web mirror can *display* the floor they are held
 * to rather than hardcoding a second copy of 15 that drifts.
 */
export const DEFAULT_MIN_COVERAGE_PERCENT = 15;
const MAX_STRONGEST_DRIVERS = 3;

/**
 * Strengths ordered weakest-first by credit multiplier.
 *
 * `recipientLocation` and `inferred` share a multiplier (0.5), so their relative
 * order cannot change any score — it is fixed here only so that combining them
 * is deterministic, and `recipientLocation` is listed first because a geographic
 * fallback is the more specific claim to warn about.
 */
const STRENGTH_ORDER: readonly EvidenceStrength[] = [
  'absent',
  'statewide',
  'recipientLocation',
  'inferred',
  'sourceAuthoritative',
  'verified',
];

/**
 * The weaker of two strengths.
 *
 * Used when the same component is evidenced at different qualities across
 * several districts and has to be collapsed into one client-level claim. It
 * takes the weaker deliberately: if one district's grant geography came from
 * recipient location, the client-level grant claim is no longer purely
 * place-of-performance evidence, and reporting the stronger of the two would
 * launder a degraded basis into a full-weight one. This is the same rule
 * `foldDistricts` already applies to `assistanceBasis` within a single district.
 */
export function weakerStrength(a: EvidenceStrength, b: EvidenceStrength): EvidenceStrength {
  return STRENGTH_ORDER.indexOf(a) <= STRENGTH_ORDER.indexOf(b) ? a : b;
}

const TOTAL_WEIGHT = Object.values(NEXUS_COMPONENT_WEIGHTS).reduce((sum, w) => sum + w, 0);

/**
 * Score one subject (a client, or a client within one district).
 *
 * Everything returned is explainable: `breakdown` accounts for all 100 points,
 * including the ones not earned, so the UI can always answer "why this number".
 */
export function scoreNexus(input: NexusScoreInput): NexusScoreResult {
  const minCoverage = input.minCoveragePercent ?? DEFAULT_MIN_COVERAGE_PERCENT;
  const breakdown: NexusScoreBreakdown[] = [];
  const warnings: DataQualityWarning[] = [];

  let creditTotal = 0;
  let coveredWeight = 0;

  for (const component of NEXUS_COMPONENTS) {
    const weight = NEXUS_COMPONENT_WEIGHTS[component];
    const evidence = input.components[component];
    const strength: EvidenceStrength = evidence?.strength ?? 'absent';

    // Rule 3: an awarded-funding component backed only by opportunities earns
    // nothing, no matter how strong the underlying opportunity data is.
    const suppressedByOpportunityOnly =
      evidence?.opportunityOnly === true && AWARDED_FUNDING_COMPONENTS.has(component);

    const multiplier = suppressedByOpportunityOnly ? 0 : STRENGTH_MULTIPLIER[strength];
    // Rule 5: exact, never rounded here.
    const credit = weight * multiplier;

    const rationale = suppressedByOpportunityOnly
      ? 'Backed only by grant opportunities, which are forecasts — no awarded-funding credit.'
      : STRENGTH_RATIONALE[strength];

    breakdown.push({
      component,
      label: NEXUS_COMPONENT_LABELS[component],
      weight,
      credit,
      rationale,
      evidenceCount: evidence?.evidenceCount ?? 0,
    });

    creditTotal += credit;

    // Rule 1: only determinate evidence counts toward coverage. An
    // opportunity-suppressed component IS determinate — we looked and found
    // only forecasts — so it counts as covered while earning zero.
    if (strength !== 'absent') coveredWeight += weight;

    if (suppressedByOpportunityOnly) {
      warnings.push({
        code: 'opportunity_only',
        message: `${NEXUS_COMPONENT_LABELS[component]} is backed only by grant opportunities, not awarded funding.`,
      });
    } else if (strength === 'statewide') {
      warnings.push({
        code: 'statewide_attribution',
        message: `${NEXUS_COMPONENT_LABELS[component]} relies on a statewide award that cannot be tied to one district.`,
      });
    } else if (strength === 'recipientLocation') {
      warnings.push({
        code: 'recipient_location_fallback',
        message: `${NEXUS_COMPONENT_LABELS[component]} uses recipient location because no place of performance was available.`,
      });
    } else if (strength === 'inferred') {
      warnings.push({
        code: 'inferred_entity_match',
        message: `${NEXUS_COMPONENT_LABELS[component]} rests on an inferred entity match rather than a verified identifier.`,
      });
    }
  }

  const coveragePercent = (coveredWeight / TOTAL_WEIGHT) * 100;

  const strongestDrivers = breakdown
    .filter((b) => b.credit > 0)
    .sort((a, b) => b.credit - a.credit)
    .slice(0, MAX_STRONGEST_DRIVERS);

  // Rule 5: this is the single rounding boundary in the whole module.
  const score = coveragePercent < minCoverage ? null : Math.round(creditTotal);

  if (score === null) {
    warnings.push({
      code: 'unmapped_amount',
      message: `Too little evidence to score honestly — ${coveragePercent.toFixed(0)}% coverage is below the ${minCoverage}% floor.`,
    });
  }

  return { score, coveragePercent, breakdown, strongestDrivers, warnings };
}
