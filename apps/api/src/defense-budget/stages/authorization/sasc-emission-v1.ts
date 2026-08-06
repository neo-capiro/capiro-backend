import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
} from '../../contracts/artifact-builders.js';
import { moneyToMillionsString } from '../../contracts/decimal-string.js';
import type { BudgetLineIdentityV1 } from '../../contracts/extraction-artifact-v1.js';
import {
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../congressional-table-v1.js';
import { nativeIdentityKeyV1 } from '../budget-line-reference-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../stage-source-profile-v1.js';
import type {
  StageActionDraftV1,
  StageBaselineFactV1,
  StageOmissionV1,
  StagePositionV1,
} from '../stage-row-emitter-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
  committeeRequestBaselineV1Schema,
  committeeStageActionV1Schema,
  type CommitteeStageActionTypeV1,
} from './committee-stage-facts-v1.js';
import {
  sascActionMoney,
  sascActionType,
  sascFiscalYear,
  sascSignedValue,
  sascSourcePath,
  sascTableKey,
} from './sasc-composition-helpers-v1.js';

export function emitSascPosition(
  builder: ArtifactBuilderV1,
  profile: DefenseBudgetStageSourceProfileV1,
  position: StagePositionV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  if (position.field !== 'sascMark') {
    throw new Error(`SASC emitter produced prohibited field '${position.field}'`);
  }
  const factId = factIdV1({
    stage: 'sasc',
    table: sascTableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(position.identity),
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
  });
  builder.addSourceFact({
    factId,
    sourcePath: sascSourcePath(table, row, 'sasc-mark'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: { directOrDerived: position.provenance },
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ factId, field: 'sascMark' }),
    sourceFactIds: [factId],
    evidenceIds,
    confidence: position.provenance === 'direct' ? 1 : 0.99,
    identity: position.identity,
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
    field: 'sascMark',
    money: {
      originalValue: position.value,
      originalUnit: position.unit,
      valueMillions: moneyToMillionsString(position.value, position.unit),
    },
    metadata: {
      stage: 'sasc',
      profileId: profile.profileId,
      profileHash: stageSourceProfileHashV1(profile),
      directOrDerived: position.provenance,
      physicalPage: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
      ...(position.derivation != null
        ? {
            derivationBaseline: position.derivation.baseline,
            derivationChange: position.derivation.change,
          }
        : {}),
    },
  });
}

export function emitSascBaseline(
  builder: ArtifactBuilderV1,
  baseline: StageBaselineFactV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const value = committeeRequestBaselineV1Schema.parse({
    schemaVersion: COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
    stage: 'sasc',
    authority: 'sasc_authorization',
    identity: baseline.identity,
    fiscalYear: baseline.fiscalYear ?? sascFiscalYear(table),
    money: {
      originalValue: baseline.value,
      originalUnit: baseline.unit,
      valueMillions: moneyToMillionsString(baseline.value, baseline.unit),
    },
    evidenceIds,
  });
  const factId = factIdV1({
    stage: 'sasc',
    table: sascTableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(baseline.identity),
    kind: 'request_baseline',
  });
  builder.addSourceFact({
    factId,
    sourcePath: sascSourcePath(table, row, 'request-baseline'),
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
    metadata: { nonOwningComparisonFact: true, stage: 'sasc' },
  });
}

export function emitSascStageAction(
  builder: ArtifactBuilderV1,
  action: StageActionDraftV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const actionType = sascActionType(row, action.amount);
  addSascActionAssertion({
    builder,
    table,
    row,
    identity: action.identity,
    actionType,
    amount: sascSignedValue(actionType, action.amount),
    unit: action.unit,
    fiscalYear: action.fiscalYear ?? sascFiscalYear(table),
    evidenceIds,
  });
}

export function emitSascDirectAction(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  identity: BudgetLineIdentityV1,
  amount: RowMoneyV1,
  evidenceIds: string[],
): void {
  const actionType = sascActionType(row, amount.value);
  addSascActionAssertion({
    builder,
    table,
    row,
    identity,
    actionType,
    amount: sascSignedValue(actionType, amount.value),
    unit: amount.unit,
    fiscalYear: amount.fiscalYear ?? sascFiscalYear(table),
    evidenceIds,
  });
}

export function emitSascPackageAction(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): boolean {
  const amount = sascActionMoneyForRow(table, row);
  if (amount == null || row.reference.referenceKind !== 'package_scope') return false;
  const actionType = sascActionType(row, amount.value);
  addSascActionAssertion({
    builder,
    table,
    row,
    packageScope: row.reference.scope,
    actionType,
    amount: sascSignedValue(actionType, amount.value),
    unit: amount.unit,
    fiscalYear: amount.fiscalYear ?? sascFiscalYear(table),
    evidenceIds,
  });
  return true;
}

function addSascActionAssertion(input: {
  builder: ArtifactBuilderV1;
  table: CongressionalTableV1;
  row: CongressionalRowV1;
  identity?: BudgetLineIdentityV1;
  packageScope?: string;
  actionType: CommitteeStageActionTypeV1;
  amount: string;
  unit: 'dollars' | 'thousands' | 'millions';
  fiscalYear: number;
  evidenceIds: string[];
}): void {
  const actionId = assertionIdV1({
    stage: 'sasc',
    table: sascTableKey(input.table),
    row: input.row.rowIndex,
    actionType: input.actionType,
    identity:
      input.identity != null
        ? nativeIdentityKeyV1(input.identity)
        : (input.packageScope ?? input.row.rawLabel),
  });
  const signedMillions = moneyToMillionsString(input.amount, input.unit);
  const value = committeeStageActionV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
    actionId,
    track: 'authorization',
    stage: 'sasc',
    authority: 'sasc_authorization',
    actionType: input.actionType,
    ...(input.identity != null ? { identity: input.identity } : {}),
    ...(input.packageScope != null ? { packageScope: input.packageScope } : {}),
    fiscalYear: input.fiscalYear,
    amount: {
      originalValue: input.amount,
      originalUnit: input.unit,
      valueMillions: signedMillions,
    },
    signedValueMillions: signedMillions,
    rationale: input.row.finding ?? input.row.rawLabel,
    evidenceIds: input.evidenceIds,
    direct: true,
  });
  const factId = factIdV1({ actionId, kind: 'sasc_stage_action' });
  input.builder.addSourceFact({
    factId,
    sourcePath: sascSourcePath(input.table, input.row, 'stage-action'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: value,
    evidenceIds: input.evidenceIds,
  });
  input.builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: actionId,
    sourceFactIds: [factId],
    evidenceIds: input.evidenceIds,
    confidence: 1,
    fieldName: DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    value,
  });
}

export function emitSascStageOmission(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
  omission: StageOmissionV1,
): void {
  const reason =
    omission.reason === 'binding_not_accepted'
      ? 'invalid_identity'
      : omission.reason === 'undeclared_unit'
        ? 'unsupported_unit'
        : omission.reason === 'row_not_interpretable'
          ? 'unsupported_field'
          : 'missing_value';
  omitSascRow(
    builder,
    table,
    row,
    evidenceIds,
    reason,
    sascStageOmissionSeverity(omission),
    `SASC stage emission omitted row: ${omission.reason}${
      omission.detail != null ? ` (${omission.detail})` : ''
    }`,
  );
}

export function sascStageOmissionSeverity(
  omission: StageOmissionV1,
): 'review' | 'blocking' {
  return omission.reason === 'row_not_interpretable' && omission.rawLabel.length > 0
    ? 'review'
    : 'blocking';
}

export function addSascEvidence(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  parserRunId: string,
): string[] {
  const cells =
    row.cells.length === 0
      ? [{ rowIndex: row.rowIndex, columnIndex: -1, rawText: '' }]
      : row.cells;
  const evidenceIds = cells.map((cell) => {
    const evidenceId = evidenceIdV1({
      stage: 'sasc',
      table: sascTableKey(table),
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
    const validBox = box != null && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite);
    builder.addEvidence({
      evidenceId,
      sourcePdfSha256: table.sourceSha256,
      parserRunId,
      granularity: validBox ? 'cell_bbox' : cell.textSpan != null ? 'text_span' : 'page_only',
      page: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
      ...(validBox ? { boundingBox: box } : {}),
      ...(cell.textSpan != null ? { textSpan: cell.textSpan } : {}),
      rowLabel: row.rawLabel,
      columnLabel: table.columns.find((column) => column.columnIndex === cell.columnIndex)
        ?.headerText,
      ...(cell.rawText ? { excerpt: cell.rawText } : {}),
    });
    return evidenceId;
  });

  const continuation = /continued from physical page (\d+)/i.exec(row.finding ?? '');
  if (continuation != null) {
    const sourcePage = Number(continuation[1]);
    if (Number.isInteger(sourcePage) && sourcePage > 0 && sourcePage !== table.page) {
      const evidenceId = evidenceIdV1({
        stage: 'sasc',
        kind: 'continuation_identity',
        sourcePage,
        continuationPage: table.page,
        rowLabel: row.rawLabel,
      });
      builder.addEvidence({
        evidenceId,
        sourcePdfSha256: table.sourceSha256,
        parserRunId,
        granularity: 'page_only',
        page: sourcePage,
        rowLabel: row.rawLabel,
        excerpt: row.rawLabel,
      });
      evidenceIds.unshift(evidenceId);
    }
  }
  return evidenceIds;
}

export function omitSascRow(
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
    stage: 'sasc',
    table: sascTableKey(table),
    row: row.rowIndex,
    reason,
    rawLabel: row.rawLabel,
  });
  builder.addSourceFact({
    factId,
    sourcePath: sascSourcePath(table, row, 'omission'),
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

export function sascActionMoneyForRow(
  table: CongressionalTableV1,
  row: CongressionalRowV1,
): RowMoneyV1 | undefined {
  return sascActionMoney(rowMoneyV1(table, row));
}
