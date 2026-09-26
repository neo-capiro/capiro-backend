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
  subject: { type: 'program' | 'program_element' | 'project' | 'budget_line'; id: string; label: string };
  projectionVersion: 'defense-dossier-v1';
  fields: readonly DefenseDossierFieldDto[];
  coverage: { state: DefenseResearchAvailability; expectedFields: number; availableFields: number; partialFields: number; unavailableFields: number };
}

export interface DefenseMilestonePeriodDto {
  role: 'planned' | 'actual';
  rawText: string;
  precision: 'exact_date' | 'calendar_month' | 'calendar_quarter' | 'fiscal_quarter' | 'fiscal_year' | 'text_only' | 'range' | 'unknown';
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
  history: readonly { revision: string; observedAt: string | null; periods: readonly DefenseMilestonePeriodDto[] }[];
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
  supported: { fiscalYears: readonly number[]; editions: readonly string[]; stages: readonly string[]; metrics: readonly DefenseFundingBasisDto['metric'][]; knownAt: boolean };
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
  resolvedTarget: { type: string; id: string; versionId: string | null; sectionId: string | null } | null;
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
  denominator: { eligible: number; observed: number; qualified: number; available: number; partial: number; unavailable: number };
}
