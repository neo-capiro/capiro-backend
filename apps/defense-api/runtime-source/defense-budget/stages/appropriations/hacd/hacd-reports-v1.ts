/** Phase 6 Workstream H — HAC-D family/account coverage and unresolved reports. */
import type { ExtractionSourceV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  nativeIdentityKeyV1,
  type ResolvedBudgetLineBindingV1,
} from '../../budget-line-reference-v1.js';
import type { CongressionalRowV1, CongressionalTableV1 } from '../../congressional-table-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';
import { hacdAccountKey, hacdIsClassified } from './hacd-composition-helpers-v1.js';

export const HACD_COVERAGE_REPORT_SCHEMA_VERSION = 'hacd_coverage_report_v1' as const;
export const HACD_UNRESOLVED_REPORT_SCHEMA_VERSION = 'hacd_unresolved_report_v1' as const;

export type HacdLineFamilyV1 =
  | 'RDTE_PE'
  | 'PROCUREMENT_BLIN'
  | 'OM_SAG'
  | 'MILCON_PROJECT'
  | 'CLASSIFIED'
  | 'PACKAGE_SCOPE'
  | 'UNKNOWN';

export interface HacdCoverageBucketV1 {
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

export interface HacdAccountCoverageV1 {
  representedRows: number;
  positionsEmitted: number;
  actionsEmitted: number;
  omissions: number;
}

export interface HacdCoverageReportV1 {
  schemaVersion: typeof HACD_COVERAGE_REPORT_SCHEMA_VERSION;
  profileId: string;
  profileHash: string;
  sourceDocumentId: string;
  sourceSha256: string;
  byLineFamily: Record<HacdLineFamilyV1, HacdCoverageBucketV1>;
  byAccount: Record<string, HacdAccountCoverageV1>;
  totals: HacdCoverageBucketV1;
  status: 'complete' | 'complete_with_review' | 'blocked';
}

export interface HacdUnresolvedBindingV1 {
  page: number;
  printedPage?: string;
  rowIndex: number;
  rawLabel: string;
  lineFamily: HacdLineFamilyV1;
  accountKey?: string;
  status: Extract<
    ResolvedBudgetLineBindingV1['status'],
    'candidate' | 'unresolved' | 'conflicting'
  >;
  basis: ResolvedBudgetLineBindingV1['basis'];
  candidateIdentityKeys: string[];
  evidenceIds: string[];
}

export interface HacdUnresolvedReportV1 {
  schemaVersion: typeof HACD_UNRESOLVED_REPORT_SCHEMA_VERSION;
  profileId: string;
  sourceDocumentId: string;
  sourceSha256: string;
  entries: HacdUnresolvedBindingV1[];
}

const EMPTY_BUCKET: HacdCoverageBucketV1 = {
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

export function createHacdCoverageReport(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): HacdCoverageReportV1 {
  return {
    schemaVersion: HACD_COVERAGE_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    profileHash: stageSourceProfileHashV1(profile),
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    byLineFamily: {
      RDTE_PE: { ...EMPTY_BUCKET },
      PROCUREMENT_BLIN: { ...EMPTY_BUCKET },
      OM_SAG: { ...EMPTY_BUCKET },
      MILCON_PROJECT: { ...EMPTY_BUCKET },
      CLASSIFIED: { ...EMPTY_BUCKET },
      PACKAGE_SCOPE: { ...EMPTY_BUCKET },
      UNKNOWN: { ...EMPTY_BUCKET },
    },
    byAccount: {},
    totals: { ...EMPTY_BUCKET },
    status: 'complete',
  };
}

export function createHacdUnresolvedReport(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): HacdUnresolvedReportV1 {
  return {
    schemaVersion: HACD_UNRESOLVED_REPORT_SCHEMA_VERSION,
    profileId: profile.profileId,
    sourceDocumentId: source.sourceDocumentId ?? source.manifestDocumentKey,
    sourceSha256: source.sourcePdfSha256,
    entries: [],
  };
}

export function hacdLineFamily(
  row: CongressionalRowV1,
  table: CongressionalTableV1,
): HacdLineFamilyV1 {
  if (row.reference.referenceKind === 'pe_code') return 'RDTE_PE';
  if (row.reference.referenceKind === 'procurement_line') return 'PROCUREMENT_BLIN';
  if (row.reference.referenceKind === 'om_sag') return 'OM_SAG';
  if (row.reference.referenceKind === 'milcon_project') return 'MILCON_PROJECT';
  if (hacdIsClassified(row, table)) return 'CLASSIFIED';
  if (row.reference.referenceKind === 'package_scope') return 'PACKAGE_SCOPE';
  return 'UNKNOWN';
}

export function touchHacdAccountCoverage(
  report: HacdCoverageReportV1,
  row: CongressionalRowV1,
): HacdAccountCoverageV1 | null {
  const key = hacdAccountKey(row);
  if (key == null) return null;
  const existing = report.byAccount[key] ?? {
    representedRows: 0,
    positionsEmitted: 0,
    actionsEmitted: 0,
    omissions: 0,
  };
  report.byAccount[key] = existing;
  return existing;
}

export function addHacdUnresolvedBinding(input: {
  report: HacdUnresolvedReportV1;
  table: CongressionalTableV1;
  row: CongressionalRowV1;
  binding: ResolvedBudgetLineBindingV1;
  evidenceIds: string[];
}): void {
  if (input.binding.status === 'accepted') return;
  const accountKey = hacdAccountKey(input.row);
  input.report.entries.push({
    page: input.table.page,
    ...(input.table.printedPage != null ? { printedPage: input.table.printedPage } : {}),
    rowIndex: input.row.rowIndex,
    rawLabel: input.row.rawLabel,
    lineFamily: hacdLineFamily(input.row, input.table),
    ...(accountKey != null ? { accountKey } : {}),
    status: input.binding.status,
    basis: input.binding.basis,
    candidateIdentityKeys: input.binding.candidates.map(nativeIdentityKeyV1).sort(),
    evidenceIds: [...input.evidenceIds].sort(),
  });
}

export function finalizeHacdReports(
  coverage: HacdCoverageReportV1,
  unresolved: HacdUnresolvedReportV1,
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

export function countHacdBinding(
  bucket: HacdCoverageBucketV1,
  total: HacdCoverageBucketV1,
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

export function countHacdPosition(
  bucket: HacdCoverageBucketV1,
  total: HacdCoverageBucketV1,
  account: HacdAccountCoverageV1 | null,
): void {
  bucket.positionsEmitted += 1;
  total.positionsEmitted += 1;
  if (account != null) account.positionsEmitted += 1;
}

export function countHacdAction(
  bucket: HacdCoverageBucketV1,
  total: HacdCoverageBucketV1,
  account: HacdAccountCoverageV1 | null,
): void {
  bucket.actionsEmitted += 1;
  total.actionsEmitted += 1;
  if (account != null) account.actionsEmitted += 1;
}

export function countHacdOmission(
  bucket: HacdCoverageBucketV1,
  total: HacdCoverageBucketV1,
  account: HacdAccountCoverageV1 | null,
  severity: 'review' | 'blocking',
): void {
  bucket.omissions += 1;
  total.omissions += 1;
  if (account != null) account.omissions += 1;
  const key = severity === 'review' ? 'reviewOmissions' : 'blockingOmissions';
  bucket[key] += 1;
  total[key] += 1;
}
