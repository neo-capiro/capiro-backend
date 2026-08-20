/** Phase 6 Workstream H — HAC-D artifact emission helpers. */
import {
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  type ArtifactBuilderV1,
} from '../../../contracts/artifact-builders.js';
import { moneyToMillionsString } from '../../../contracts/decimal-string.js';
import type { BudgetLineIdentityV1 } from '../../../contracts/extraction-artifact-v1.js';
import {
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../../congressional-table-v1.js';
import { nativeIdentityKeyV1 } from '../../budget-line-reference-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';
import type {
  StageActionDraftV1,
  StageBaselineFactV1,
  StageOmissionV1,
  StagePositionV1,
} from '../../stage-row-emitter-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
  committeeRequestBaselineV1Schema,
  committeeStageActionV1Schema,
  type CommitteeStageActionTypeV1,
} from '../../authorization/committee-stage-facts-v1.js';
import {
  hacdActionMoney,
  hacdActionType,
  hacdFiscalYear,
  hacdSignedValue,
  hacdSourcePath,
  hacdTableKey,
} from './hacd-composition-helpers-v1.js';

export function emitHacdPosition(
  builder: ArtifactBuilderV1,
  profile: DefenseBudgetStageSourceProfileV1,
  position: StagePositionV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  if (position.field !== 'hacDMark') {
    throw new Error(`HAC-D emitter produced prohibited field '${position.field}'`);
  }
  const factId = factIdV1({
    stage: 'hac_d',
    table: hacdTableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(position.identity),
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
  });
  builder.addSourceFact({
    factId,
    sourcePath: hacdSourcePath(table, row, 'hacd-mark'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: { directOrDerived: position.provenance },
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ factId, field: 'hacDMark' }),
    sourceFactIds: [factId],
    evidenceIds,
    confidence: position.provenance === 'direct' ? 1 : 0.99,
    identity: position.identity,
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
    field: 'hacDMark',
    money: {
      originalValue: position.value,
      originalUnit: position.unit,
      valueMillions: moneyToMillionsString(position.value, position.unit),
    },
    metadata: {
      track: 'appropriations',
      stage: 'hac_d',
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

export function emitHacdBaseline(
  builder: ArtifactBuilderV1,
  baseline: StageBaselineFactV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const value = committeeRequestBaselineV1Schema.parse({
    schemaVersion: COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
    stage: 'hac_d',
    authority: 'hacd_appropriations',
    identity: baseline.identity,
    fiscalYear: baseline.fiscalYear ?? hacdFiscalYear(table),
    money: {
      originalValue: baseline.value,
      originalUnit: baseline.unit,
      valueMillions: moneyToMillionsString(baseline.value, baseline.unit),
    },
    evidenceIds,
  });
  const factId = factIdV1({
    stage: 'hac_d',
    table: hacdTableKey(table),
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(baseline.identity),
    kind: 'request_baseline',
  });
  builder.addSourceFact({
    factId,
    sourcePath: hacdSourcePath(table, row, 'request-baseline'),
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
    metadata: { nonOwningComparisonFact: true, track: 'appropriations', stage: 'hac_d' },
  });
}

export function emitHacdStageAction(
  builder: ArtifactBuilderV1,
  action: StageActionDraftV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const actionType = hacdActionType(row, action.amount);
  addHacdActionAssertion({
    builder,
    table,
    row,
    identity: action.identity,
    actionType,
    amount: hacdSignedValue(actionType, action.amount),
    unit: action.unit,
    fiscalYear: action.fiscalYear ?? hacdFiscalYear(table),
    evidenceIds,
  });
}

export function emitHacdDirectAction(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  identity: BudgetLineIdentityV1,
  amount: RowMoneyV1,
  evidenceIds: string[],
): void {
  const actionType = hacdActionType(row, amount.value);
  addHacdActionAssertion({
    builder,
    table,
    row,
    identity,
    actionType,
    amount: hacdSignedValue(actionType, amount.value),
    unit: amount.unit,
    fiscalYear: amount.fiscalYear ?? hacdFiscalYear(table),
    evidenceIds,
  });
}

export function emitHacdPackageAction(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): boolean {
  if (row.reference.referenceKind !== 'package_scope') return false;
  const amount = hacdActionMoney(rowMoneyV1(table, row));
  if (amount == null) return false;
  const actionType = hacdActionType(row, amount.value);
  addHacdActionAssertion({
    builder,
    table,
    row,
    packageScope: row.reference.scope,
    actionType,
    amount: hacdSignedValue(actionType, amount.value),
    unit: amount.unit,
    fiscalYear: amount.fiscalYear ?? hacdFiscalYear(table),
    evidenceIds,
  });
  return true;
}

function addHacdActionAssertion(input: {
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
    stage: 'hac_d',
    table: hacdTableKey(input.table),
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
    track: 'appropriations',
    stage: 'hac_d',
    authority: 'hacd_appropriations',
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
  const factId = factIdV1({ actionId, kind: 'hacd_stage_action' });
  input.builder.addSourceFact({
    factId,
    sourcePath: hacdSourcePath(input.table, input.row, 'stage-action'),
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

export function addHacdEvidence(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  parserRunId: string,
): string[] {
  const cells =
    row.cells.length === 0 ? [{ rowIndex: row.rowIndex, columnIndex: -1, rawText: '' }] : row.cells;
  return cells.map((cell) => {
    const evidenceId = evidenceIdV1({
      stage: 'hac_d',
      table: hacdTableKey(table),
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
}

export function emitHacdStageOmission(
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
  omitHacdRow(
    builder,
    table,
    row,
    evidenceIds,
    reason,
    hacdStageOmissionSeverity(omission),
    `HAC-D stage emission omitted row: ${omission.reason}${
      omission.detail != null ? ` (${omission.detail})` : ''
    }`,
  );
}

export function hacdStageOmissionSeverity(omission: StageOmissionV1): 'review' | 'blocking' {
  return omission.reason === 'row_not_interpretable' && omission.rawLabel.length > 0
    ? 'review'
    : 'blocking';
}

export function omitHacdRow(
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
    stage: 'hac_d',
    table: hacdTableKey(table),
    row: row.rowIndex,
    reason,
    rawLabel: row.rawLabel,
  });
  builder.addSourceFact({
    factId,
    sourcePath: hacdSourcePath(table, row, 'omission'),
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
