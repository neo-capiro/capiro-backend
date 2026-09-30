export type DefenseResearchAvailability = 'available' | 'partial' | 'unavailable';

export interface DefenseEvidenceRefDto {
  evidenceRefId: string;
  sourceDocumentId: string | null;
  sourceRevisionId: string | null;
  sourceFamily: string;
  publisher: string | null;
  sourceUrl: string | null;
  nativeLocator: { page: number | null; section: string | null; occurrenceId: string | null };
  contentHash: string | null;
  edition: string | null;
  observedAt: string | null;
}

export interface DefenseDossierFieldDto<T = string> {
  field: string;
  availability: DefenseResearchAvailability;
  value: T | null;
  reason: string | null;
  fiscalPeriod: string | null;
  metric: string | null;
  unit: string | null;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseDossierDto {
  subject: {
    type: 'program' | 'program_element' | 'project' | 'budget_line';
    id: string;
    label: string;
  };
  projectionVersion: 'defense-dossier-v1';
  fields: readonly DefenseDossierFieldDto[];
  coverage: {
    state: DefenseResearchAvailability;
    expectedFields: number;
    availableFields: number;
    partialFields: number;
    unavailableFields: number;
  };
}

export interface DefenseMilestonePeriodDto {
  role: 'planned' | 'actual';
  rawText: string;
  precision:
    | 'exact_date'
    | 'calendar_month'
    | 'calendar_quarter'
    | 'fiscal_quarter'
    | 'fiscal_year'
    | 'text_only'
    | 'range'
    | 'unknown';
  exactDate: string | null;
  rangeStart: string | null;
  rangeEnd: string | null;
  fiscalYear: number | null;
  quarter: number | null;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseMilestoneDto {
  id: string;
  projectId: string | null;
  eventCategory: 'development' | 'testing' | 'production' | 'transition' | 'other';
  label: string;
  status: string | null;
  periods: readonly DefenseMilestonePeriodDto[];
  observedAt: string | null;
  edition: string | null;
  history: readonly {
    revision: string;
    observedAt: string | null;
    periods: readonly DefenseMilestonePeriodDto[];
  }[];
}

export interface DefenseMilestoneResponseDto {
  subject: DefenseDossierDto['subject'];
  projectionVersion: 'defense-milestones-v1';
  milestones: readonly DefenseMilestoneDto[];
  coverage: { state: DefenseResearchAvailability; reason: string | null };
}

export interface DefenseFundingBasisDto {
  requestEdition: string | null;
  fundingFiscalYear: number;
  stage: string;
  metric: 'funding' | 'quantity' | 'unit_cost';
  unit: 'usd_millions' | 'units' | 'usd_millions_per_unit';
  currency: 'USD';
  priceBasis: string | null;
  knownAt: string | null;
  knowledgeTimeSupported: boolean;
}

export interface DefenseFundingCellDto {
  basis: DefenseFundingBasisDto;
  value: string | null;
  disposition: 'observed' | 'missing' | 'partial' | 'unavailable' | 'withheld';
  sourceObservationId: string;
  replacedByObservationId: string | null;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseFundingMatrixDto {
  subject: DefenseDossierDto['subject'];
  projectionVersion: 'defense-funding-matrix-v1';
  cells: readonly DefenseFundingCellDto[];
  supported: {
    fiscalYears: readonly number[];
    editions: readonly string[];
    stages: readonly string[];
    metrics: readonly DefenseFundingBasisDto['metric'][];
    knownAt: boolean;
  };
  limitations: readonly string[];
}

export interface DefenseContextDocumentSummaryDto {
  id: string;
  family: string;
  publisher: string;
  title: string;
  congress: number | null;
  committee: string | null;
  publishedAt: string | null;
  status: string;
  currentRevisionId: string | null;
  transcriptAvailability: 'available' | 'partial' | 'unavailable' | 'not_applicable';
  coverage: DefenseResearchAvailability;
  sourceUrl: string | null;
}

export interface DefenseContextDocumentRevisionDto {
  id: string;
  version: string;
  contentHash: string | null;
  publishedAt: string | null;
  observedAt: string;
  status: string;
  sourceUrl: string | null;
}

export interface DefenseContextSectionDto {
  id: string;
  revisionId: string;
  ordinal: number;
  label: string;
  nativeLocator: string | null;
  textAvailability: DefenseResearchAvailability;
  contentHash: string | null;
}

export interface DefenseReferenceOccurrenceDto {
  id: string;
  sourceDocumentId: string;
  sourceRevisionId: string;
  sourceSectionId: string | null;
  exactSpan: string;
  originalWording: string;
  referenceType: string;
  targetCandidates: readonly { type: string; id: string; label: string }[];
  resolvedTarget: {
    type: string;
    id: string;
    versionId: string | null;
    sectionId: string | null;
  } | null;
  disposition: 'resolved' | 'ambiguous' | 'unresolved' | 'unavailable';
  evidenceRef: DefenseEvidenceRefDto;
}

export interface DefenseContextDocumentDetailDto extends DefenseContextDocumentSummaryDto {
  revisions: readonly DefenseContextDocumentRevisionDto[];
  sections: readonly DefenseContextSectionDto[];
  coverageReason: string | null;
}

export interface DefenseContextDocumentListDto {
  items: readonly DefenseContextDocumentSummaryDto[];
  nextCursor: string | null;
  denominator: {
    eligible: number;
    observed: number;
    qualified: number;
    available: number;
    partial: number;
    unavailable: number;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Offices and typed relationships (Phase 5)
// ──────────────────────────────────────────────────────────────────────────────

export type OfficeStatus = 'active' | 'historical' | 'superseded' | 'unresolved';
export type OfficeRelation =
  | 'manages'
  | 'executes'
  | 'issues'
  | 'administers'
  | 'pays'
  | 'supports'
  | 'sponsors'
  | 'tests'
  | 'transitions'
  | 'performs'
  | 'holds_role'
  | 'acquisition_path';

export interface DefenseOfficeSummaryDto {
  id: string;
  name: string;
  officeType:
    'peo' | 'pm' | 'cpe' | 'pae' | 'directorate' | 'command' | 'contracting_office' | 'other';
  service: string | null;
  parentOfficeId: string | null;
  parentOfficeName: string | null;
  status: OfficeStatus;
  validFrom: string | null;
  validTo: string | null;
  sourceUrl: string | null;
  reviewStatus: 'accepted' | 'candidate' | 'quarantined' | null;
  confidence: number;
  observedAt: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  aliases: readonly string[];
  availability: DefenseResearchAvailability;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseOfficeDetailDto extends DefenseOfficeSummaryDto {
  mission: string | null;
  responsibilities: string | null;
  scope: string | null;
  leadership: readonly {
    personId: string;
    personName: string;
    roleTitle: string;
    roleType: string;
    contactUse: string;
    observedAt: string;
    effectiveStart: string | null;
    effectiveEnd: string | null;
    reviewStatus: 'accepted' | 'candidate' | 'quarantined';
    sourceUrl: string | null;
    evidence: readonly DefenseEvidenceRefDto[];
  }[];
  programs: readonly {
    programId: string;
    programName: string;
    relation: OfficeRelation;
    reviewStatus: 'accepted' | 'candidate' | 'quarantined';
    sourceUrl: string | null;
    evidence: readonly DefenseEvidenceRefDto[];
  }[];
  contact: string | null;
  website: string | null;
  hierarchy: {
    parent: DefenseOfficeSummaryDto | null;
    children: readonly DefenseOfficeSummaryDto[];
  };
  coverage: {
    mission: DefenseResearchAvailability;
    responsibilities: DefenseResearchAvailability;
    scope: DefenseResearchAvailability;
    leadership: DefenseResearchAvailability;
    programs: DefenseResearchAvailability;
    contact: DefenseResearchAvailability;
    website: DefenseResearchAvailability;
  };
}

export interface DefenseOfficeListDto {
  items: readonly DefenseOfficeSummaryDto[];
  total: number;
  page: number;
  limit: number;
  filters: {
    agency?: string;
    component?: string;
    officeType?: string;
    capability?: string;
    program?: string;
    status?: OfficeStatus;
    availability?: DefenseResearchAvailability;
    freshness?: 'fresh' | 'stale' | 'any';
  };
}

export interface DefenseRelationshipNodeDto {
  type:
    | 'program'
    | 'program_element'
    | 'project'
    | 'budget_line'
    | 'office'
    | 'person'
    | 'contractor'
    | 'acquisition'
    | 'evidence';
  id: string;
  label: string;
  service?: string | null;
}

export interface DefenseRelationshipEdgeDto {
  id: string;
  from: DefenseRelationshipNodeDto;
  to: DefenseRelationshipNodeDto;
  relation:
    OfficeRelation | 'mentions' | 'cites' | 'applies_to' | 'amends' | 'supersedes' | 'allocates';
  sourceStated: boolean;
  derived: boolean;
  inferred: boolean;
  validity: 'valid' | 'candidate' | 'superseded' | 'unresolved';
  observationRevision: string | null;
  evidence: readonly DefenseEvidenceRefDto[];
  reviewStatus: 'accepted' | 'candidate' | 'quarantined';
  supersessionImpact: string | null;
}

export interface DefenseRelationshipListDto {
  items: readonly DefenseRelationshipEdgeDto[];
  total: number;
  page: number;
  limit: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Acquisition continuity (Phase 6)
// ──────────────────────────────────────────────────────────────────────────────

export type AcquisitionRelationshipClass =
  | 'source_stated_financial_allocation'
  | 'deterministic_financial_allocation'
  | 'reviewed_association'
  | 'inferred_relevance'
  | 'unresolved';

export interface DefenseAcquisitionRecordSummaryDto {
  identityKey: string;
  sourceSystem: string;
  sourceRecordId: string;
  recordKind: string;
  parentIdentityKey: string | null;
  title: string | null;
  status: string | null;
  buyerOffice: string | null;
  postedAt: string | null;
  responseDeadline: string | null;
  validFrom: string | null;
  validTo: string | null;
  contentHash: string;
  sourceUrl: string | null;
  sourceVersion: string | null;
  sourceObservedAt: string | null;
  recordedAt: string;
  textAvailability: DefenseResearchAvailability;
  amendmentCount: number;
  openCoverageGaps: number;
}

export interface DefenseAcquisitionRecordDetailDto extends DefenseAcquisitionRecordSummaryDto {
  revisions: readonly {
    id: string;
    identityKey: string;
    sourceSystem: string;
    sourceRecordId: string;
    recordKind: string;
    title: string | null;
    status: string | null;
    buyerOffice: string | null;
    postedAt: string | null;
    responseDeadline: string | null;
    validFrom: string | null;
    validTo: string | null;
    contentHash: string;
    sourceUrl: string | null;
    sourceVersion: string | null;
    sourceObservedAt: string | null;
    recordedAt: string;
    raw: unknown;
  }[];
  childIdentities: readonly string[];
  amendmentIdentities: readonly string[];
  extractedFields: {
    geography?: string[];
    naics?: string[];
    psc?: string[];
    setAside?: string[];
  };
  associations: readonly {
    relationshipId: string;
    relationshipClass: AcquisitionRelationshipClass;
    subjectKind: string;
    subjectKey: string;
    subjectLabel: string | null;
    validFromFy: number | null;
    validToFy: number | null;
    allocatedAmountUsd: string | null;
    sourceUrl: string | null;
    sourceObservedAt: string | null;
    reviewStatus: 'accepted' | 'candidate' | 'quarantined';
  }[];
}

export interface DefenseAcquisitionRecordActionDto {
  transactionIdentityKey: string;
  awardIdentityKey: string;
  parentAwardIdentityKey: string | null;
  sourceSystem: string;
  sourceTransactionId: string;
  piid: string | null;
  modificationNumber: string | null;
  actionDate: string | null;
  signedObligationDelta: string | null;
  signedOutlayDelta: string | null;
  correctsIdentityKey: string | null;
  supersedesId: string | null;
  sourceUrl: string | null;
  sourceObservedAt: string | null;
  recordedAt: string;
  raw: unknown;
}

export interface DefenseAcquisitionCoverageGapDto {
  id: string;
  subjectKind: string;
  subjectKey: string;
  sourceSystem: string;
  relationshipKind: string;
  reason: string;
  detail: string | null;
  coverageState: string;
  sourceAsOf: string | null;
  firstObservedAt: string;
  lastObservedAt: string;
  resolvedAt: string | null;
}

export interface DefenseAcquisitionRecordListDto {
  items: readonly DefenseAcquisitionRecordSummaryDto[];
  total: number;
  page: number;
  limit: number;
  filters: {
    q?: string;
    sourceSystem?: string;
    recordKind?: string;
    status?: string;
    buyerOffice?: string;
    activeOn?: string;
  };
}

export interface DefenseAcquisitionCoverageGapListDto {
  items: readonly DefenseAcquisitionCoverageGapDto[];
  total: number;
  page: number;
  limit: number;
  filters: {
    subjectKind: string;
    subjectKey: string;
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Customer research surfaces (Phase 8)
// ──────────────────────────────────────────────────────────────────────────────

export type DefenseSearchSubjectType =
  | 'program_element'
  | 'program'
  | 'project'
  | 'budget_line'
  | 'office'
  | 'acquisition'
  | 'context_document';

export interface DefenseSearchMatchExplanation {
  queryTerm: string;
  matchedFields: readonly string[];
  rationale: string;
  negativeControls: readonly string[];
}

export interface DefenseSearchMatchDto {
  subject: { type: DefenseSearchSubjectType; id: string; label: string };
  secondaryLabel: string | null;
  matchKind: 'exact_id' | 'canonical_name' | 'alias' | 'acronym' | 'capability' | 'semantic';
  score: number | null;
  explanation: DefenseSearchMatchExplanation;
  availability: DefenseResearchAvailability;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseSearchLaneDto {
  status: 'available' | 'disabled' | 'abstained';
  reason: string | null;
  items: readonly DefenseSearchMatchDto[];
}

export interface DefenseSearchQueryExpansion {
  original: string;
  normalized: string;
  terms: readonly string[];
  excludedTerms: readonly string[];
  applied: boolean;
}

export interface DefenseSearchResponseDto {
  query: string;
  expansion: DefenseSearchQueryExpansion;
  exact: DefenseSearchLaneDto;
  capability: DefenseSearchLaneDto;
  semantic: DefenseSearchLaneDto;
  limitations: readonly string[];
}

export interface DefenseComparisonSubjectDto {
  key: string;
  type: DefenseDossierDto['subject']['type'] | 'context_document';
  id: string;
  label: string;
  availability: DefenseResearchAvailability;
}

export interface DefenseComparisonCellDto {
  subjectKey: string;
  value: string | null;
  disposition: 'observed' | 'missing' | 'unavailable' | 'incompatible';
  reason: string | null;
  evidence: readonly DefenseEvidenceRefDto[];
}

export interface DefenseComparisonMetricDto {
  key: string;
  label: string;
  period: string | null;
  metric: string;
  unit: string | null;
  grain: string;
  cells: readonly DefenseComparisonCellDto[];
}

export interface DefenseComparisonAlignmentDto {
  kind: 'funding' | 'milestone' | 'passage' | 'table';
  state: 'aligned' | 'partial' | 'unavailable';
  reason: string | null;
  subjectEvidence: Readonly<Record<string, readonly DefenseEvidenceRefDto[]>>;
}

export interface DefenseComparisonResponseDto {
  projectionVersion: string;
  subjects: readonly DefenseComparisonSubjectDto[];
  metrics: readonly DefenseComparisonMetricDto[];
  alignments: readonly DefenseComparisonAlignmentDto[];
  limitations: readonly string[];
}

export interface DefenseProductCoverageDenominatorDto {
  state: 'known' | 'unknown';
  value: number | null;
  unit: 'physical_documents';
  reason: string;
  attestedAt: string | null;
}

export interface DefenseProductCoverageRowDto {
  perimeter: string;
  component: string | null;
  account: string | null;
  family: string;
  fiscalYear: number;
  edition: string | null;
  stage: string;
  detail: string | null;
  asOf: string;
  denominator: DefenseProductCoverageDenominatorDto;
  discovered: number;
  parsed: number;
  qualified: number;
  published: number;
  outcome: 'complete' | 'partial' | 'unavailable' | 'unknown';
  limitations: readonly string[];
}

export interface DefenseProductCoverageResponseDto {
  projectionVersion: string;
  filters: {
    perimeter?: string;
    component?: string;
    account?: string;
    family?: string;
    fiscalYear?: number;
    edition?: string;
    stage?: string;
    detail?: string;
  };
  rows: readonly DefenseProductCoverageRowDto[];
  denominatorKnown: boolean;
  limitations: readonly string[];
}
