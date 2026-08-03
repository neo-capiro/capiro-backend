/**
 * Workstream I3 — Independent comparison types.
 *
 * Supports:
 *   cross_document_summary_detail
 *   project_rollup_reference
 *   procurement_summary_detail
 *   committee_request_reference
 *   historical_consistency
 *
 * Historical consistency is never sufficient proof of a current-year amount.
 * It may adjust risk or flag anomalies only.
 */
import type { JsonValue } from '../../../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Comparison kinds                                                    */
/* ------------------------------------------------------------------ */

export const COMPARISON_KIND_V1_VALUES = [
  'cross_document_summary_detail',
  'project_rollup_reference',
  'procurement_summary_detail',
  'committee_request_reference',
  'historical_consistency',
] as const;
export type ComparisonKindV1 = (typeof COMPARISON_KIND_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Reference match result                                              */
/* ------------------------------------------------------------------ */

/** Zero, one, or multiple matches — never silently reduced to one. */
export type ReferenceMatchResultV1<T> =
  | { kind: 'zero' }
  | { kind: 'one'; value: T }
  | { kind: 'multiple'; values: readonly T[] };

/* ------------------------------------------------------------------ */
/* Comparison input                                                    */
/* ------------------------------------------------------------------ */

/** Natural key for indexing reference artifacts. */
export interface ReferenceIndexKeyV1 {
  assertionKind: string;
  identityKey: string;
  fiscalYear: number;
  field?: string;
  projectCode?: string;
}

/** A resolved reference artifact entry in the index. */
export interface ReferenceArtifactEntryV1 {
  artifactId: string;
  contentSha256: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  assertionId: string;
  assertionKind: string;
  identityKey: string;
  fiscalYear: number;
  field?: string;
  projectCode?: string;
  evidenceIds: readonly string[];
  valueMillions?: string;
}

/* ------------------------------------------------------------------ */
/* Comparison outcome                                                  */
/* ------------------------------------------------------------------ */

export const COMPARISON_OUTCOME_V1_VALUES = [
  'PASS',
  'FAIL',
  'NOT_RUN',
  'SKIPPED',
  'AMBIGUOUS',
] as const;
export type ComparisonOutcomeV1 = (typeof COMPARISON_OUTCOME_V1_VALUES)[number];

/* ------------------------------------------------------------------ */
/* Comparison mismatch detail (I5)                                     */
/* ------------------------------------------------------------------ */

export interface ComparisonMismatchDetailV1 {
  candidateAssertionId: string;
  candidateEvidenceId: string;
  referenceArtifactId: string;
  referenceAssertionId: string;
  referenceEvidenceId: string;
  candidateValue: string;
  referenceValue: string;
  tolerance: string;
  difference: string;
}

/* ------------------------------------------------------------------ */
/* Comparison result                                                   */
/* ------------------------------------------------------------------ */

export interface ComparisonResultV1 {
  kind: ComparisonKindV1;
  outcome: ComparisonOutcomeV1;
  required: boolean;
  mismatches: ComparisonMismatchDetailV1[];
  matchedAssertionIds: string[];
  referenceArtifactIds: string[];
  details?: Record<string, JsonValue>;
}

/**
 * Historical consistency is never sufficient proof of a current-year amount.
 * It may adjust risk or flag anomalies only.
 */
export function isHistoricalConsistency(kind: ComparisonKindV1): boolean {
  return kind === 'historical_consistency';
}
