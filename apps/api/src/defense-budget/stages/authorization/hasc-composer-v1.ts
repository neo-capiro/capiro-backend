/** Phase 6 Workstream D — deterministic, write-free HASC stage composition. */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
} from '../../contracts/artifact-builders.js';
import {
  moneyToMillionsString,
  parseCanonicalDecimalString,
} from '../../contracts/decimal-string.js';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  composeDuplicateRowsV1,
  congressionalTableV1Schema,
  deriveAbsolutePositionV1,
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../congressional-table-v1.js';
import {
  nativeIdentityKeyV1,
  type ResolvedBudgetLineBindingV1,
} from '../budget-line-reference-v1.js';
import {
  resolveBudgetLineReferenceV1,
  type LineReferenceResolutionContext,
} from '../line-reference-resolver.js';
import {
  parseStageSourceProfileV1,
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
  committeeRequestBaselineV1Schema,
  committeeStageActionV1Schema,
  type CommitteeStageActionTypeV1,
} from './committee-stage-facts-v1.js';
import { HASC_TABLE_COMPOSITION_POLICY_V1 } from './hasc-source-profile-v1.js';

export const HASC_COVERAGE_REPORT_SCHEMA_VERSION = 'hasc_coverage_report_v1' as const;
export type HascNativeLineKindV1 =
  | 'RDTE_PE'
  | 'PROCUREMENT_BLIN'
  | 'OM_SAG'
  | 'MILCON_PROJECT'
  | 'PACKAGE_SCOPE'
  | 'UNKNOWN';
export interface HascCoverageBucketV1 {
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
export interface HascCoverageReportV1 {
  schemaVersion: typeof HASC_COVERAGE_REPORT_SCHEMA_VERSION;
  profileId: string;
  profileHash: string;
  sourceDocumentId: string;
  sourceSha256: string;
  byLineKind: Record<HascNativeLineKindV1, HascCoverageBucketV1>;
  totals: HascCoverageBucketV1;
  status: 'complete' | 'complete_with_review' | 'blocked';
}
export interface ComposeHascStageV1Input {
  profile: DefenseBudgetStageSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly CongressionalTableV1[];
  resolutionContext: LineReferenceResolutionContext;
}
export interface ComposeHascStageV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  coverage: HascCoverageReportV1;
}

const EMPTY: HascCoverageBucketV1 = {
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

export function composeHascStageV1(input: ComposeHascStageV1Input): ComposeHascStageV1Result {
  const profile = parseStageSourceProfileV1(input.profile);
  if (profile.stage !== 'hasc' || profile.authority !== 'hasc_authorization') {
    throw new Error('HASC composer requires stage=hasc and authority=hasc_authorization');
  }
  if (input.source.authority !== 'hasc') throw new Error("HASC source authority must be 'hasc'");
  if (input.source.fiscalYear !== profile.fiscalYear) throw new Error('HASC fiscal-year mismatch');

  const builder = new ArtifactBuilderV1(input.source);
  const standInRun = {
    parserRunId: parserRunIdV1({
      source: input.source.sourcePdfSha256,
      profile: profile.profileId,
    }),
    method: 'manual' as const,
    parserVersion: 'hasc-stage-composer-v1',
    parserConfigSha256: stageSourceProfileHashV1(profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? standInRun.parserRunId;
  const coverage = newCoverage(profile, input.source);
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  for (const raw of input.tables) {
    const table = congressionalTableV1Schema.parse(raw);
    assertTableBinding(table, profile, input.source);
    const duplicate = duplicateDisposition(table);
    const evidence = new Map<number, string[]>();
    for (const row of table.rows)
      evidence.set(row.rowIndex, addEvidence(builder, table, row, runId));

    for (const row of table.rows) {
      const bucket = coverage.byLineKind[lineKind(row)];
      bucket.representedRows += 1;
      coverage.totals.representedRows += 1;
      const ownEvidence = evidence.get(row.rowIndex) ?? [];
      const packageAction = isPackageAction(row);
      let binding: ResolvedBudgetLineBindingV1 | undefined;
      if (!packageAction) {
        binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
        binding.supportingEvidenceIds = ownEvidence;
        bindings.push(binding);
        countBinding(bucket, coverage.totals, binding.status);
      }
      if (duplicate.conflicts.has(row.rowIndex)) {
        omit(
          builder,
          table,
          row,
          ownEvidence,
          'ambiguous_layout',
          'blocking',
          'duplicate HASC rows state conflicting totals',
        );
        countOmission(bucket, coverage.totals, 'blocking');
        continue;
      }
      if (duplicate.secondary.has(row.rowIndex)) continue;
      const allEvidence = (duplicate.groups.get(row.rowIndex) ?? [row]).flatMap(
        (item) => evidence.get(item.rowIndex) ?? [],
      );

      if (packageAction) {
        if (emitAction(builder, table, row, undefined, allEvidence))
          countAction(bucket, coverage.totals);
        else {
          omit(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'package-scope HASC action has no typed amount',
          );
          countOmission(bucket, coverage.totals, 'blocking');
        }
        continue;
      }
      if (binding?.status !== 'accepted' || binding.targetIdentity == null) {
        const severity = binding?.status === 'candidate' ? 'review' : 'blocking';
        omit(
          builder,
          table,
          row,
          allEvidence,
          'invalid_identity',
          severity,
          `HASC row binding is ${binding?.status ?? 'unresolved'}; machine pass is forbidden`,
        );
        countOmission(bucket, coverage.totals, severity);
        continue;
      }
      if (row.semanticKind === 'absolute_position') {
        emitPosition(
          builder,
          profile,
          table,
          row,
          binding.targetIdentity,
          allEvidence,
          bucket,
          coverage,
        );
        continue;
      }
      if (isAction(row)) {
        if (emitAction(builder, table, row, binding.targetIdentity, allEvidence)) {
          countAction(bucket, coverage.totals);
        } else {
          omit(
            builder,
            table,
            row,
            allEvidence,
            'missing_value',
            'blocking',
            'HASC action row has no typed amount',
          );
          countOmission(bucket, coverage.totals, 'blocking');
        }
        continue;
      }
      const severity = row.semanticKind === 'narrative_only' ? 'review' : 'blocking';
      omit(
        builder,
        table,
        row,
        allEvidence,
        'unsupported_field',
        severity,
        `HASC row semantic '${row.semanticKind}' does not emit a funding position`,
      );
      countOmission(bucket, coverage.totals, severity);
    }
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(standInRun);
  coverage.status =
    coverage.totals.unresolvedBindings > 0 ||
    coverage.totals.conflictingBindings > 0 ||
    coverage.totals.blockingOmissions > 0
      ? 'blocked'
      : coverage.totals.candidateBindings > 0 || coverage.totals.reviewOmissions > 0
        ? 'complete_with_review'
        : 'complete';
  return { artifact: builder.finalize(), bindings, coverage };
}

function emitPosition(
  builder: ArtifactBuilderV1,
  profile: DefenseBudgetStageSourceProfileV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  identity: BudgetLineIdentityV1,
  evidenceIds: string[],
  bucket: HascCoverageBucketV1,
  coverage: HascCoverageReportV1,
): void {
  emitBaseline(builder, table, row, identity, evidenceIds);
  const derived = deriveAbsolutePositionV1(table, row, HASC_TABLE_COMPOSITION_POLICY_V1);
  if (derived.status === 'blocked') {
    const noUnit =
      table.declaredUnit == null && table.columns.every((column) => column.declaredUnit == null);
    omit(
      builder,
      table,
      row,
      evidenceIds,
      noUnit ? 'unsupported_unit' : 'missing_value',
      'blocking',
      noUnit ? 'HASC money row has no declared unit' : `HASC position blocked: ${derived.reason}`,
    );
    countOmission(bucket, coverage.totals, 'blocking');
    return;
  }
  const factId = factIdV1({
    stage: 'hasc',
    table: tableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(identity),
    fiscalYear: derived.fiscalYear ?? profile.fiscalYear,
  });
  builder.addSourceFact({
    factId,
    sourcePath: sourcePath(table, row, 'hasc-mark'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: { directOrDerived: derived.status },
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ factId, field: 'hascMark' }),
    sourceFactIds: [factId],
    evidenceIds,
    confidence: derived.status === 'direct' ? 1 : 0.99,
    identity,
    fiscalYear: derived.fiscalYear ?? profile.fiscalYear,
    field: 'hascMark',
    money: {
      originalValue: derived.value,
      originalUnit: derived.unit,
      valueMillions: moneyToMillionsString(derived.value, derived.unit),
    },
    metadata: {
      stage: 'hasc',
      profileId: profile.profileId,
      profileHash: stageSourceProfileHashV1(profile),
      directOrDerived: derived.status,
      physicalPage: table.page,
      ...(derived.status === 'derived'
        ? { derivationBaseline: derived.baseline, derivationChange: derived.change }
        : {}),
    },
  });
  countPosition(bucket, coverage.totals);
  if (
    actionMoney(rowMoneyV1(table, row)) != null &&
    emitAction(builder, table, row, identity, evidenceIds)
  ) {
    countAction(bucket, coverage.totals);
  }
}

function emitBaseline(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  identity: BudgetLineIdentityV1,
  evidenceIds: string[],
): void {
  const baseline = rowMoneyV1(table, row).find((item) => item.semantic === 'request_baseline');
  if (baseline == null) return;
  const value = committeeRequestBaselineV1Schema.parse({
    schemaVersion: COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
    stage: 'hasc',
    authority: 'hasc_authorization',
    identity,
    fiscalYear: baseline.fiscalYear ?? fiscalYear(table),
    money: {
      originalValue: baseline.value,
      originalUnit: baseline.unit,
      valueMillions: moneyToMillionsString(baseline.value, baseline.unit),
    },
    evidenceIds,
  });
  const factId = factIdV1({
    stage: 'hasc',
    table: tableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(identity),
    kind: 'request_baseline',
  });
  builder.addSourceFact({
    factId,
    sourcePath: sourcePath(table, row, 'request-baseline'),
    category: 'money',
    requiredForCompleteness: false,
    rawValue: value,
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ factId, fieldName: COMMITTEE_REQUEST_BASELINE_FIELD }),
    sourceFactIds: [factId],
    evidenceIds,
    confidence: 1,
    fieldName: COMMITTEE_REQUEST_BASELINE_FIELD,
    value,
    metadata: { nonOwningComparisonFact: true, stage: 'hasc' },
  });
}

function emitAction(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  identity: BudgetLineIdentityV1 | undefined,
  evidenceIds: string[],
): boolean {
  const amount = actionMoney(rowMoneyV1(table, row));
  if (amount == null) return false;
  const actionKind = actionType(row, amount.value);
  const signed = signedValue(actionKind, amount.value);
  const packageScope =
    row.reference.referenceKind === 'package_scope' ? row.reference.scope : undefined;
  const actionId = assertionIdV1({
    stage: 'hasc',
    table: tableKey(table),
    row: row.rowIndex,
    actionType: actionKind,
    identity: identity == null ? (packageScope ?? row.rawLabel) : nativeIdentityKeyV1(identity),
  });
  const value = committeeStageActionV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
    actionId,
    track: 'authorization',
    stage: 'hasc',
    authority: 'hasc_authorization',
    actionType: actionKind,
    ...(identity != null ? { identity } : {}),
    ...(packageScope != null ? { packageScope } : {}),
    fiscalYear: amount.fiscalYear ?? fiscalYear(table),
    amount: {
      originalValue: signed,
      originalUnit: amount.unit,
      valueMillions: moneyToMillionsString(signed, amount.unit),
    },
    signedValueMillions: moneyToMillionsString(signed, amount.unit),
    rationale: row.finding ?? row.rawLabel,
    evidenceIds,
    direct: true,
  });
  const factId = factIdV1({ actionId, kind: 'hasc_stage_action' });
  builder.addSourceFact({
    factId,
    sourcePath: sourcePath(table, row, 'stage-action'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: value,
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: actionId,
    sourceFactIds: [factId],
    evidenceIds,
    confidence: 1,
    fieldName: DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    value,
  });
  return true;
}

function addEvidence(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  parserRunId: string,
): string[] {
  const cells =
    row.cells.length === 0 ? [{ rowIndex: row.rowIndex, columnIndex: -1, rawText: '' }] : row.cells;
  return cells.map((cell) => {
    const evidenceId = evidenceIdV1({
      stage: 'hasc',
      table: tableKey(table),
      row: row.rowIndex,
      column: cell.columnIndex,
      rawText: cell.rawText,
    });
    const rawBox = 'boundingBox' in cell ? cell.boundingBox : undefined;
    const box =
      rawBox == null
        ? undefined
        : {
            x0: Number(rawBox.x0),
            y0: Number(rawBox.y0),
            x1: Number(rawBox.x1),
            y1: Number(rawBox.y1),
            coordinateSystem: 'pdf_points' as const,
          };
    const valid = box != null && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite);
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: table.sourceSha256,
      parserRunId,
      granularity: valid ? 'cell_bbox' : cell.textSpan != null ? 'text_span' : 'page_only',
      page: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
      ...(valid ? { boundingBox: box } : {}),
      ...(cell.textSpan != null ? { textSpan: cell.textSpan } : {}),
      rowLabel: row.rawLabel,
      columnLabel: table.columns.find((column) => column.columnIndex === cell.columnIndex)
        ?.headerText,
      ...(cell.rawText ? { excerpt: cell.rawText } : {}),
    });
    return evidenceId;
  });
}

function omit(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
  reason:
    | 'invalid_identity'
    | 'ambiguous_layout'
    | 'unsupported_unit'
    | 'missing_value'
    | 'unsupported_field',
  severity: 'review' | 'blocking',
  message: string,
): void {
  const factId = factIdV1({
    stage: 'hasc',
    table: tableKey(table),
    row: row.rowIndex,
    reason,
    rawLabel: row.rawLabel,
  });
  builder.addSourceFact({
    factId,
    sourcePath: sourcePath(table, row, 'omission'),
    category: reason === 'invalid_identity' ? 'identity' : 'metadata',
    requiredForCompleteness: true,
    rawValue: { rowLabel: row.rawLabel, semanticKind: row.semanticKind },
    evidenceIds,
  });
  builder.addOmission({
    omissionId: omissionIdV1({ factId, reason, message }),
    sourceFactId: factId,
    reason,
    severity,
    message,
  });
}

function duplicateDisposition(table: CongressionalTableV1) {
  const conflicts = new Set<number>();
  const secondary = new Set<number>();
  const groups = new Map<number, CongressionalRowV1[]>();
  for (const group of composeDuplicateRowsV1(table, HASC_TABLE_COMPOSITION_POLICY_V1)) {
    if (group.rows.length < 2) continue;
    const rows = [...group.rows].sort((a, b) => a.rowIndex - b.rowIndex);
    if (group.conflict != null) rows.forEach((row) => conflicts.add(row.rowIndex));
    else if (group.agreedValue != null) {
      groups.set(rows[0]!.rowIndex, rows);
      rows.slice(1).forEach((row) => secondary.add(row.rowIndex));
    }
  }
  return { conflicts, secondary, groups };
}
function actionMoney(values: RowMoneyV1[]): RowMoneyV1 | undefined {
  return (
    values.find((item) => item.semantic === 'change') ??
    values.find((item) => item.semantic === 'transfer_amount') ??
    values.find((item) => item.semantic === 'rescission_amount')
  );
}
function actionType(row: CongressionalRowV1, value: string): CommitteeStageActionTypeV1 {
  if (row.semanticKind === 'transfer_in') return 'transfer_in';
  if (row.semanticKind === 'transfer_out') return 'transfer_out';
  if (row.semanticKind === 'rescission') return 'rescission';
  if (row.semanticKind === 'undistributed') return 'undistributed_adjustment';
  if (row.semanticKind === 'general_provision') return 'general_provision';
  return value.startsWith('-') ? 'decrease' : 'increase';
}
function signedValue(type: CommitteeStageActionTypeV1, value: string): string {
  const canonical = parseCanonicalDecimalString(value);
  const magnitude = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  if (magnitude === '0') return '0';
  return ['decrease', 'transfer_out', 'rescission'].includes(type) ? `-${magnitude}` : magnitude;
}
function fiscalYear(table: CongressionalTableV1): number {
  const values = [
    ...new Set(
      table.columns.flatMap((column) => (column.fiscalYear == null ? [] : [column.fiscalYear])),
    ),
  ];
  if (values.length !== 1) throw new Error('HASC row requires one unambiguous fiscal year');
  return values[0]!;
}
function isAction(row: CongressionalRowV1): boolean {
  return ['adjustment', 'transfer_in', 'transfer_out', 'rescission', 'undistributed'].includes(
    row.semanticKind,
  );
}
function isPackageAction(row: CongressionalRowV1): boolean {
  return (
    ['general_provision', 'undistributed'].includes(row.semanticKind) &&
    row.reference.referenceKind === 'package_scope'
  );
}
function lineKind(row: CongressionalRowV1): HascNativeLineKindV1 {
  if (row.reference.referenceKind === 'pe_code') return 'RDTE_PE';
  if (row.reference.referenceKind === 'procurement_line') return 'PROCUREMENT_BLIN';
  if (row.reference.referenceKind === 'om_sag') return 'OM_SAG';
  if (row.reference.referenceKind === 'milcon_project') return 'MILCON_PROJECT';
  if (row.reference.referenceKind === 'package_scope') return 'PACKAGE_SCOPE';
  return 'UNKNOWN';
}
function tableKey(table: CongressionalTableV1) {
  return {
    page: table.page,
    printedPage: table.printedPage ?? null,
    headings: table.headings,
    columns: table.columns.map(({ columnIndex, headerText }) => ({ columnIndex, headerText })),
  };
}
function sourcePath(table: CongressionalTableV1, row: CongressionalRowV1, suffix: string): string {
  const heading = table.headings.join(' > ').replace(/\s+/g, ' ').trim() || 'unheaded';
  return `page:${table.page}/table:${heading}/row:${row.rowIndex}/${suffix}`;
}
function assertTableBinding(
  table: CongressionalTableV1,
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): void {
  if (table.profileId !== profile.profileId) throw new Error('HASC table profileId mismatch');
  if (table.sourceSha256 !== source.sourcePdfSha256)
    throw new Error('HASC table source SHA mismatch');
  if (table.sourceDocumentId !== (source.sourceDocumentId ?? source.manifestDocumentKey)) {
    throw new Error('HASC table sourceDocumentId mismatch');
  }
}
function newCoverage(
  profile: DefenseBudgetStageSourceProfileV1,
  source: ExtractionSourceV1,
): HascCoverageReportV1 {
  return {
    schemaVersion: HASC_COVERAGE_REPORT_SCHEMA_VERSION,
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
function countBinding(
  bucket: HascCoverageBucketV1,
  total: HascCoverageBucketV1,
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
function countPosition(bucket: HascCoverageBucketV1, total: HascCoverageBucketV1): void {
  bucket.positionsEmitted += 1;
  total.positionsEmitted += 1;
}
function countAction(bucket: HascCoverageBucketV1, total: HascCoverageBucketV1): void {
  bucket.actionsEmitted += 1;
  total.actionsEmitted += 1;
}
function countOmission(
  bucket: HascCoverageBucketV1,
  total: HascCoverageBucketV1,
  severity: 'review' | 'blocking',
): void {
  bucket.omissions += 1;
  total.omissions += 1;
  const key = severity === 'review' ? 'reviewOmissions' : 'blockingOmissions';
  bucket[key] += 1;
  total[key] += 1;
}
