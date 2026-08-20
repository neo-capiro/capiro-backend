export type FederalFundingMeasureType =
  | 'regular_appropriation'
  | 'supplemental'
  | 'emergency_supplemental'
  | 'reconciliation'
  | 'continuing_resolution'
  | 'rescission'
  | 'transfer'
  | 'reprogramming';

export type FederalFundingMeasureStatus =
  | 'draft'
  | 'introduced'
  | 'enacted'
  | 'active'
  | 'superseded'
  | 'withdrawn'
  | 'expired';

export type FederalFundingAuthorityType = 'discretionary' | 'mandatory' | 'mixed';

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

export type FederalFundingMappingReviewState = 'candidate' | 'verified' | 'rejected';

export interface FederalFundingEvidenceRef {
  readonly sourceDocumentId: string;
  readonly sourcePage: number | null;
  readonly evidenceSha256: string;
}

export interface FederalFundingMeasureDto {
  readonly id: string;
  readonly measureType: FederalFundingMeasureType;
  readonly status: FederalFundingMeasureStatus;
  readonly authorityType: FederalFundingAuthorityType;
  readonly fiscalYear: number | null;
  readonly availabilityStart: string | null;
  readonly availabilityEnd: string | null;
  readonly legislationId: string | null;
  readonly publicLawNumber: string | null;
  readonly title: string;
  readonly evidence: FederalFundingEvidenceRef;
  readonly dedupKey: string;
}

export interface FederalFundingProvisionDto {
  readonly id: string;
  readonly measureId: string;
  readonly section: string | null;
  readonly agency: string | null;
  readonly component: string | null;
  readonly appropriationTitle: string | null;
  readonly tas: string | null;
  readonly statedAmountUsd: string | null;
  readonly purposeText: string;
  readonly designation: string | null;
  readonly transferAuthority: string | null;
  readonly availabilityStart: string | null;
  readonly availabilityEnd: string | null;
  readonly evidence: FederalFundingEvidenceRef;
  readonly dedupKey: string;
}

export interface FederalFundingAllocationDto {
  readonly id: string;
  readonly provisionId: string;
  readonly targetType: FederalFundingTargetType;
  readonly targetNativeKey: string | null;
  readonly targetId: string | null;
  readonly allocationStage: FederalFundingAllocationStage;
  readonly mappingMaturity: FederalFundingMappingMaturity;
  readonly reviewState: FederalFundingMappingReviewState;
  readonly authoritativeAmountUsd: string | null;
  readonly inferredRelevance: boolean;
  readonly confidence: number | null;
  readonly baseRequestStatus: 'unknown' | 'included' | 'not_included' | 'partial';
  readonly potentialDoubleCount: boolean;
  readonly fundingPosture: 'unknown' | 'one_time' | 'recurring';
  readonly evidence: FederalFundingEvidenceRef;
  readonly obligationReference: string | null;
  readonly executionReference: string | null;
  readonly dedupKey: string;
}

export interface FederalFundingActivityEventV1 {
  readonly schemaVersion: 'federal_funding_activity_v1';
  readonly eventId: string;
  readonly eventType:
    | 'measure_created'
    | 'measure_status_changed'
    | 'provision_verified'
    | 'allocation_verified'
    | 'mapping_review_required'
    | 'obligation_observed';
  readonly measureId: string;
  readonly provisionId?: string | null;
  readonly allocationId?: string | null;
  readonly fiscalYear?: number | null;
  readonly sourceDocumentId: string;
  readonly evidenceSha256: string;
  readonly occurredAt: string;
}
