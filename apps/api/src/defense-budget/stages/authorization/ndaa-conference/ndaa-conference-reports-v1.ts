/** Phase 6 Workstream G — conference coverage and unresolved reports. */
import type { ExtractionSourceV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  nativeIdentityKeyV1,
  type ResolvedBudgetLineBindingV1,
} from '../../budget-line-reference-v1.js';
import type { CongressionalRowV1 } from '../../congressional-table-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';

export const NDAA_CONFERENCE_COVERAGE_REPORT_SCHEMA_VERSION =
  'ndaa_conference_coverage_report_v1' as const;
export const NDAA_CONFERENCE_UNRESOLVED_REPORT_SCHEMA_VERSION =
  'ndaa_conference_unresolved_report_v1' as const;

export type NdaaConferenceLineKindV1 =
  | 'RDTE_PE'
  | 'PROCUREMENT_BLIN'
  | 'OM_SAG'
  | 'MILCON_PROJECT'
  | 'PACKAGE_SCOPE'
  | 'UNKNOWN';

export interface NdaaConferenceCoverageBucketV1 {
  representedRows: number;
  acceptedBindings: number;
  candidateBindings: number;
  unresolvedBindings: number;
  conflictingBindings: number;
  positionsEmitted: number;
  omissions: number;
  blockingOmissions: number;
  reviewOmissions: number;
}

export interface NdaaConferenceCoverageReportV1 {
  schemaVersion: typeof NDAA_CONFERENCE_COVERAGE_REPORT_SCHEMA_VERSION;
  profileId: string;
  profileHash: string;
  sourceDocumentId: string;
  sourceSha256: string;
  byLineKind: Record<NdaaConferenceLineKindV1, NdaaConferenceCoverageBucketV1>;
  totals: NdaaConferenceCoverageBucketV1;
  status: 'complete' | 'complete_with_review' | 'blocked';
}

export interface NdaaConferenceUnresolvedReportV1 {
  schemaVersion: typeof NDAA_CONFERENCE_UNRESOLVED_REPORT_SCHEMA_VERSION;
  profileId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  entries: Array<{
    page: number;
    printedPage?: string;
    rowIndex: number;
    rawLabel: string;
    lineKind: NdaaConferenceLineKindV1;
    status: Extract<ResolvedBudgetLineBindingV1['status'], 'candidate' | 'unresolved' | 'conflicting'>;
    basis: ResolvedBudgetLineBindingV1['basis'];
    candidateIdentityKeys: string[];
    evidenceIds: string[];
  }>;
}

const EMPTY: NdaaConferenceCoverageBucketV1 = {
  representedRows: 0,
  acceptedBindings: 0,
  candidateBindings: 0,
  unresolvedBindings: 0,
  conflictingBindings: 0,
  positionsEmitted: 0,
  omissions: 0,
  blockingOmissions: 0,
  reviewOmissions: 0,
};

export function createNdaaConferenceCoverageReportV1(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): NdaaConferenceCoverageReportV1 {
  return {
    schemaVersion: NDAA_CONFERENCE_COVERAGE_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileHash: stageSourceProfileHashV1(profile),
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    byLineKind: {
      RDTE_PE: { ...EMPTY },
      PROCUREMENT_BLIN: { ...EMPTY },
      OM_SAG: { ...EMPTY },
      MILCON_PROJECT: { ...EMPTY },
      PACKAGE_SCOPE: { ...EMPTY },
      UNKNOWN: { ...EMPTY },
    },
    totals: { ...EMPTY },
    status: 'complete',
  };
}

export function createNdaaConferenceUnresolvedReportV1(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): NdaaConferenceUnresolvedReportV1 {
  return {
    schemaVersion: NDAA_CONFERENCE_UNRESOLVED_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    entries: [],
  };
}

export function ndaaConferenceLineKindV1(row: CongressionalRowV1): NdaaConferenceLineKindV1 {
  if (row.reference.referenceKind === 'pe_code') return 'RDTE_PE';
  if (row.reference.referenceKind === 'procurement_line') return 'PROCUREMENT_BLIN';
  if (row.reference.referenceKind === 'om_sag') return 'OM_SAG';
  if (row.reference.referenceKind === 'milcon_project') return 'MILCON_PROJECT';
  if (row.reference.referenceKind === 'package_scope') return 'PACKAGE_SCOPE';
  return 'UNKNOWN';
}

export function countNdaaConferenceBindingV1(
  bucket: NdaaConferenceCoverageBucketV1,
  total: NdaaConferenceCoverageBucketV1,
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

export function countNdaaConferencePositionV1(
  bucket: NdaaConferenceCoverageBucketV1,
  total: NdaaConferenceCoverageBucketV1,
): void {
  bucket.positionsEmitted += 1;
  total.positionsEmitted += 1;
}

export function countNdaaConferenceOmissionV1(
  bucket: NdaaConferenceCoverageBucketV1,
  total: NdaaConferenceCoverageBucketV1,
  severity: 'review' | 'blocking',
): void {
  bucket.omissions += 1;
  total.omissions += 1;
  const key = severity === 'review' ? 'reviewOmissions' : 'blockingOmissions';
  bucket[key] += 1;
  total[key] += 1;
}

export function addNdaaConferenceUnresolvedV1(input: {
  report: NdaaConferenceUnresolvedReportV1;
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
    lineKind: ndaaConferenceLineKindV1(input.row),
    status: input.binding.status,
    basis: input.binding.basis,
    candidateIdentityKeys: input.binding.candidates.map(nativeIdentityKeyV1).sort(),
    evidenceIds: [...input.evidenceIds].sort(),
  });
}

export function finalizeNdaaConferenceReportsV1(
  coverage: NdaaConferenceCoverageReportV1,
  unresolved: NdaaConferenceUnresolvedReportV1,
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
    (a, b) => a.page - b.page || a.rowIndex - b.rowIndex || a.rawLabel.localeCompare(b.rawLabel),
  );
}
