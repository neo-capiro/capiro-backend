/**
 * Federal Funding Event domain primitives.
 *
 * Alternative funding is intentionally separate from annual Program Element
 * stages. Congress-enacted purpose, OMB allotment, DoD/service allocation,
 * inferred relevance, obligation and outlay are different facts and may not be
 * silently collapsed.
 */

export type FundingMeasureProvenanceKind =
  | 'canonical_snapshot'
  | 'live_external'
  | 'legacy_compatibility';

export interface CanonicalSnapshotFundingProvenance {
  readonly kind: 'canonical_snapshot';
  readonly source: string;
  readonly snapshotId: string;
  readonly asOf: string;
}

export interface LiveExternalFundingProvenance {
  readonly kind: 'live_external';
  readonly source: string;
  readonly asOf: string;
  readonly windowMonths?: number;
}

export interface LegacyCompatibilityFundingProvenance {
  readonly kind: 'legacy_compatibility';
  readonly source: string;
  readonly table: string;
  readonly reason: string;
}

export type FundingMeasureProvenance =
  | CanonicalSnapshotFundingProvenance
  | LiveExternalFundingProvenance
  | LegacyCompatibilityFundingProvenance;

export interface AttributedFundingMeasure {
  readonly amountM: number;
  readonly count: number;
  readonly unit: 'USD millions';
  readonly label: string;
  readonly provenance: FundingMeasureProvenance;
}

export class MixedFundingProvenanceError extends Error {
  constructor(readonly kinds: readonly FundingMeasureProvenanceKind[]) {
    super(
      `Refusing to aggregate funding measures across provenance kinds [${[
        ...kinds,
      ].sort().join(', ')}].`,
    );
    this.name = 'MixedFundingProvenanceError';
  }
}

export function sumCompatibleFundingMeasures(
  measures: readonly AttributedFundingMeasure[],
): number {
  const kinds = new Set(measures.map((measure) => measure.provenance.kind));
  if (kinds.size > 1) throw new MixedFundingProvenanceError([...kinds]);
  return measures.reduce((sum, measure) => sum + measure.amountM, 0);
}

export function groupFundingMeasuresByProvenance(
  measures: readonly AttributedFundingMeasure[],
): Readonly<Record<FundingMeasureProvenanceKind, readonly AttributedFundingMeasure[]>> {
  return {
    canonical_snapshot: measures.filter(
      (measure) => measure.provenance.kind === 'canonical_snapshot',
    ),
    live_external: measures.filter((measure) => measure.provenance.kind === 'live_external'),
    legacy_compatibility: measures.filter(
      (measure) => measure.provenance.kind === 'legacy_compatibility',
    ),
  };
}

export type FederalFundingMeasureType =
  | 'regular_appropriation'
  | 'supplemental'
  | 'emergency_supplemental'
  | 'reconciliation'
  | 'continuing_resolution'
  | 'rescission'
  | 'transfer'
  | 'reprogramming';

export type FederalFundingAuthorityType =
  | 'discretionary'
  | 'mandatory'
  | 'mixed';

export type FederalFundingTargetType =
  | 'program_element'
  | 'program_element_project'
  | 'procurement_line'
  | 'om_activity'
  | 'milcon_project'
  | 'appropriation_account'
  | 'capability'
  | 'federal_program';

export type FederalFundingAllocationStage =
  | 'statutory'
  | 'omb_allotment'
  | 'dod_spend_plan'
  | 'service_budget_exhibit'
  | 'reprogramming'
  | 'obligated';

export type FederalFundingMappingMaturity =
  | 'exact_identifier'
  | 'exact_line_item'
  | 'account_level'
  | 'capability_inference'
  | 'unmapped';

export type FederalFundingMappingReviewState =
  | 'candidate'
  | 'verified'
  | 'rejected';

export type FederalFundingBaseRequestStatus =
  | 'unknown'
  | 'included'
  | 'not_included'
  | 'partial';

export type FederalFundingPosture = 'unknown' | 'one_time' | 'recurring';

export interface FederalFundingAllocation {
  readonly targetType: FederalFundingTargetType;
  readonly targetNativeKey?: string | null;
  readonly targetId?: string | null;
  readonly stage: FederalFundingAllocationStage;
  readonly maturity: FederalFundingMappingMaturity;
  readonly reviewState: FederalFundingMappingReviewState;
  readonly authoritativeAmountUsd: string | null;
  readonly inferredRelevance: boolean;
  readonly confidence?: number | null;
  readonly baseRequestStatus: FederalFundingBaseRequestStatus;
  readonly potentialDoubleCount: boolean;
  readonly fundingPosture: FederalFundingPosture;
  readonly evidenceSourceDocumentId: string;
  readonly evidenceSha256: string;
  readonly obligationReference?: string | null;
}

export class InvalidFederalFundingAllocationError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid federal funding allocation: ${reason}`);
    this.name = 'InvalidFederalFundingAllocationError';
  }
}

/**
 * Mirrors the database-level Session 6 negative controls. This is intentionally
 * stricter than a display mapper: an inferred/candidate relationship may surface
 * an opportunity, but it may never acquire authoritative dollars.
 */
export function assertAuthoritativeFederalFundingAllocation<T extends FederalFundingAllocation>(
  allocation: T,
): T {
  if (!allocation.evidenceSourceDocumentId || !/^[0-9a-f]{64}$/i.test(allocation.evidenceSha256)) {
    throw new InvalidFederalFundingAllocationError('source evidence is required');
  }

  if (
    allocation.confidence !== undefined &&
    allocation.confidence !== null &&
    (!Number.isFinite(allocation.confidence) || allocation.confidence < 0 || allocation.confidence > 1)
  ) {
    throw new InvalidFederalFundingAllocationError('confidence must be between 0 and 1');
  }

  if (allocation.stage === 'obligated' && !allocation.obligationReference) {
    throw new InvalidFederalFundingAllocationError('obligated allocations require an obligation reference');
  }

  if (allocation.maturity === 'unmapped') {
    if (allocation.targetNativeKey || allocation.targetId || allocation.authoritativeAmountUsd !== null) {
      throw new InvalidFederalFundingAllocationError('unmapped allocations cannot carry target identity or dollars');
    }
  }

  if (allocation.authoritativeAmountUsd !== null) {
    if (!/^[-+]?\d+(?:\.\d{1,2})?$/.test(allocation.authoritativeAmountUsd)) {
      throw new InvalidFederalFundingAllocationError('authoritative amount must be a decimal USD string');
    }
    if (!['exact_identifier', 'exact_line_item', 'account_level'].includes(allocation.maturity)) {
      throw new InvalidFederalFundingAllocationError('authoritative dollars require exact/account-level maturity');
    }
    if (allocation.targetType === 'capability') {
      throw new InvalidFederalFundingAllocationError('capability relevance cannot carry authoritative dollars');
    }
    if (allocation.inferredRelevance) {
      throw new InvalidFederalFundingAllocationError('inferred relevance cannot carry authoritative dollars');
    }
    if (allocation.reviewState !== 'verified') {
      throw new InvalidFederalFundingAllocationError('authoritative dollars require verified mapping state');
    }
    if (!allocation.targetNativeKey && !allocation.targetId) {
      throw new InvalidFederalFundingAllocationError('authoritative dollars require a native target identity');
    }
  }

  return allocation;
}

export function canContributeToKnownFederalFundingTotal(
  allocation: FederalFundingAllocation,
): boolean {
  assertAuthoritativeFederalFundingAllocation(allocation);
  return Boolean(
    allocation.authoritativeAmountUsd !== null &&
      allocation.reviewState === 'verified' &&
      allocation.inferredRelevance === false &&
      allocation.potentialDoubleCount === false &&
      allocation.baseRequestStatus !== 'included' &&
      allocation.maturity !== 'unmapped' &&
      allocation.targetType !== 'capability',
  );
}

export interface FederalFundingMappingCandidate {
  readonly peCode?: string | null;
  readonly projectIdentifier?: string | null;
  readonly procurementLine?: string | null;
  readonly accountTas?: string | null;
  readonly milconIdentifier?: string | null;
  readonly uniqueProgramId?: string | null;
  readonly capabilitySlug?: string | null;
}

/** Workstream I mapping precedence: exact native identities always outrank inference. */
export function selectFederalFundingMappingCandidate(
  candidate: FederalFundingMappingCandidate,
): Readonly<{
  targetType: FederalFundingTargetType;
  targetNativeKey: string | null;
  maturity: FederalFundingMappingMaturity;
  inferredRelevance: boolean;
}> {
  if (candidate.peCode) {
    return { targetType: 'program_element', targetNativeKey: candidate.peCode, maturity: 'exact_identifier', inferredRelevance: false };
  }
  if (candidate.projectIdentifier) {
    return { targetType: 'program_element_project', targetNativeKey: candidate.projectIdentifier, maturity: 'exact_identifier', inferredRelevance: false };
  }
  if (candidate.procurementLine) {
    return { targetType: 'procurement_line', targetNativeKey: candidate.procurementLine, maturity: 'exact_line_item', inferredRelevance: false };
  }
  if (candidate.accountTas) {
    return { targetType: 'appropriation_account', targetNativeKey: candidate.accountTas, maturity: 'account_level', inferredRelevance: false };
  }
  if (candidate.milconIdentifier) {
    return { targetType: 'milcon_project', targetNativeKey: candidate.milconIdentifier, maturity: 'exact_identifier', inferredRelevance: false };
  }
  if (candidate.uniqueProgramId) {
    return { targetType: 'federal_program', targetNativeKey: candidate.uniqueProgramId, maturity: 'exact_identifier', inferredRelevance: false };
  }
  if (candidate.capabilitySlug) {
    return { targetType: 'capability', targetNativeKey: candidate.capabilitySlug, maturity: 'capability_inference', inferredRelevance: true };
  }
  return { targetType: 'federal_program', targetNativeKey: null, maturity: 'unmapped', inferredRelevance: false };
}
