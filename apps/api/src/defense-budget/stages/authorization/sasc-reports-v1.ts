/**
 * Phase 6 Workstream E — stage-specific SASC coverage and unresolved-reference reports.
 */
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  nativeIdentityKeyV1,
  type ResolvedBudgetLineBindingV1,
} from '../budget-line-reference-v1.js';
import type { CongressionalRowV1 } from '../congressional-table-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';

export const SASC_COVERAGE_REPORT_SCHEMA_VERSION = 'sasc_coverage_report_v1' as const;
export const SASC_UNRESOLVED_REPORT_SCHEMA_VERSION = 'sasc_unresolved_report_v1' as const;

export type SascNativeLineKindV1 =
  | 'RDTE_PE'
  | 'PROCUREMENT_BLIN'
  | 'OM_SAG'
  | 'MILCON_PROJECT'
  | 'PACKAGE_SCOPE'
  | 'UNKNOWN';

export interface SascCoverageBucketV1 {
  representedRows: number;
  acceptedBindings: number;
  candidateBindings: number;
  unresolvedBindings: number;
  conflictingBindings: number;
  positionsEmitted: number;
  actionsEmitted: number;
  omissions: number;
  reviewOmissions: number;
  blockingOmissions: number;
}

export interface SascCoverageReportV1 {
  schemaVersion: typeof SASC_COVERAGE_REPORT_SCHEMA_VERSION;
  profileId: string;
  profileHash: string;
  sourceDocumentId: string;
  sourceSha256: string;
  byLineKind: Record<SascNativeLineKindV1, SascCoverageBucketV1>;
  totals: SascCoverageBucketV1;
  status: 'complete' | 'complete_with_review' | 'blocked';
}

export interface SascUnresolvedBindingV1 {
  page: number;
  printedPage?: string;
  rowIndex: number;
  rawLabel: string;
  lineKind: SascNativeLineKindV1;
  status: Extract<
    ResolvedBudgetLineBindingV1['status'],
    'candidate' | 'unresolved' | 'conflicting'
  >;
  basis: ResolvedBudgetLineBindingV1['basis'];
  candidateIdentityKeys: string[];
  evidenceIds: string[];
}

export interface SascUnresolvedReportV1 {
  schemaVersion: typeof SASC_UNRESOLVED_REPORT_SCHEMA_VERSION;
  profileId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  entries: SascUnresolvedBindingV1[];
}

const EMPTY_BUCKET: SascCoverageBucketV1 = {
  representedRows: 0,
  acceptedBindings: 0,
  candidateBindings: 0,
  unresolvedBindings: 0,
  conflictingBindings: 0,
  positionsEmitted: 0,
  actionsEmitted: 0,
  omissions: 0,
  reviewOmissions: 0,
  blockingOmissions: 0,
};

export function createSascCoverageReport(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): SascCoverageReportV1 {
  return {
    schemaVersion: SASC_COVERAGE_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileHash: stageSourceProfileHashV1(profile),
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    byLineKind: {
      RDTE_PE: { ...EMPTY_BUCKET },
      PROCUREMENT_BLIN: { ...EMPTY_BUCKET },
      OM_SAG: { ...EMPTY_BUCKET },
      MILCON_PROJECT: { ...EMPTY_BUCKET },
      PACKAGE_SCOPE: { ...EMPTY_BUCKET },
      UNKNOWN: { ...EMPTY_BUCKET },
    },
    totals: { ...EMPTY_BUCKET },
    status: 'complete',
  };
}

export function createSascUnresolvedReport(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): SascUnresolvedReportV1 {
  return {
    schemaVersion: SASC_UNRESOLVED_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    entries: [],
  };
}

export function addSascUnresolvedBinding(input: {
  report: SascUnresolvedReportV1;
  row: CongressionalRowV1;
  page: number;
  printedPage?: string;
  binding: ResolvedBudgetLineBindingV1;
  evidenceIds: string[];
}): void {
  if (input.binding.status === 'accepted') return;
  input.report.entries.push({
    page: input.page,
    ...(input.printedPage != null ? { printedPage: input.printedPage } : {}),
    rowIndex: input.row.rowIndex,
    rawLabel: input.row.rawLabel,
    lineKind: sascLineKind(input.row),
    status: input.binding.status,
    basis: input.binding.basis,
    candidateIdentityKeys: input.binding.candidates.map(nativeIdentityKeyV1).sort(),
    evidenceIds: [...input.evidenceIds].sort(),
  });
}

export function finalizeSascReports(
  coverage: SascCoverageReportV1,
  unresolved: SascUnresolvedReportV1,
): void {
  coverage.status =
    coverage.totals.unresolvedBindings > 0 ||
    coverage.totals.conflictingBindings > 0 ||
    coverage.totals.blockingOmissions > 0
      ? 'blocked'
      : coverage.totals.candidateBindings > 0 || coverage.totals.reviewOmissions > 0
        ? 'complete_with_review'
        : 'complete';

  unresolved.entries.sort(
    (left, right) =>
      left.page - right.page ||
      left.rowIndex - right.rowIndex ||
      left.status.localeCompare(right.status) ||
      left.rawLabel.localeCompare(right.rawLabel),
  );
}

export function sascLineKind(row: CongressionalRowV1): SascNativeLineKindV1 {
  if (row.reference.referenceKind === 'pe_code') return 'RDTE_PE';
  if (row.reference.referenceKind === 'procurement_line') return 'PROCUREMENT_BLIN';
  if (row.reference.referenceKind === 'om_sag') return 'OM_SAG';
  if (row.reference.referenceKind === 'milcon_project') return 'MILCON_PROJECT';
  if (row.reference.referenceKind === 'package_scope') return 'PACKAGE_SCOPE';
  return 'UNKNOWN';
}

export function countSascBinding(
  bucket: SascCoverageBucketV1,
  total: SascCoverageBucketV1,
  status: ResolvedBudgetLineBindingV1['status'],
): void {
  const key =
    status === 'accepted'
      ? 'acceptedBindings'
      : status === 'candidate'
        ? 'candidateBindings'
        : status === 'unresolved'
          ? 'unresolvedBindings'
          : 'conflictingBindings';
  bucket[key] += 1;
  total[key] += 1;
}

export function countSascPosition(bucket: SascCoverageBucketV1, total: SascCoverageBucketV1): void {
  bucket.positionsEmitted += 1;
  total.positionsEmitted += 1;
}

export function countSascAction(bucket: SascCoverageBucketV1, total: SascCoverageBucketV1): void {
  bucket.actionsEmitted += 1;
  total.actionsEmitted += 1;
}

export function countSascOmission(
  bucket: SascCoverageBucketV1,
  total: SascCoverageBucketV1,
  severity: 'review' | 'blocking',
): void {
  bucket.omissions += 1;
  total.omissions += 1;
  const key = severity === 'review' ? 'reviewOmissions' : 'blockingOmissions';
  bucket[key] += 1;
  total[key] += 1;
}
