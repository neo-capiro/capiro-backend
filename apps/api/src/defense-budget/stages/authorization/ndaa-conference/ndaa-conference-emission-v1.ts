/** Phase 6 Workstream G — write-free NDAA conference artifact emission. */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
} from '../../../contracts/artifact-builders.js';
import { moneyToMillionsString, parseCanonicalDecimalString } from '../../../contracts/decimal-string.js';
import type { BudgetLineIdentityV1, MoneyUnitV1 } from '../../../contracts/extraction-artifact-v1.js';
import { nativeIdentityKeyV1 } from '../../budget-line-reference-v1.js';
import type { CongressionalRowV1, CongressionalTableV1 } from '../../congressional-table-v1.js';
import {
  stageSourceProfileHashV1,
  type DefenseBudgetStageSourceProfileV1,
} from '../../stage-source-profile-v1.js';
import type { StageActionDraftV1, StageBaselineFactV1, StagePositionV1 } from '../../stage-row-emitter-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
  committeeRequestBaselineV1Schema,
  committeeStageActionV1Schema,
  type CommitteeStageActionTypeV1,
} from '../committee-stage-facts-v1.js';
import {
  NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  NDAA_CONFERENCE_VEHICLE_PROOF_FIELD,
  ndaaConferenceChamberPositionsV1Schema,
  ndaaConferenceVehicleProofV1Schema,
  type NdaaConferenceVehicleProofV1,
} from './ndaa-conference-facts-v1.js';
import {
  printedConferenceMoneyForRowV1,
  type NdaaConferenceTableV1,
} from './ndaa-conference-table-v1.js';

function tableKey(table: CongressionalTableV1) {
  return {
    page: table.page,
    printedPage: table.printedPage ?? null,
    headings: table.headings,
  };
}

function sourcePath(table: CongressionalTableV1, row: CongressionalRowV1, suffix: string): string {
  const heading = table.headings.join(' > ').replace(/\s+/g, ' ').trim() || 'unheaded';
  return `page:${table.page}/table:${heading}/row:${row.rowIndex}/${suffix}`;
}

export function addNdaaConferenceEvidenceV1(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  parserRunId: string,
): string[] {
  const cells = row.cells.length === 0
    ? [{ rowIndex: row.rowIndex, columnIndex: -1, rawText: '' }]
    : row.cells;
  return cells.map((cell) => {
    const evidenceId = evidenceIdV1({
      stage: 'ndaa_conference',
      table: tableKey(table),
      row: row.rowIndex,
      column: cell.columnIndex,
      rawText: cell.rawText,
    });
    const box = cell.boundingBox == null
      ? undefined
      : {
          x0: Number(cell.boundingBox.x0),
          y0: Number(cell.boundingBox.y0),
          x1: Number(cell.boundingBox.x1),
          y1: Number(cell.boundingBox.y1),
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
      columnLabel: table.columns.find((column) => column.columnIndex === cell.columnIndex)?.headerText,
      ...(cell.rawText ? { excerpt: cell.rawText } : {}),
    });
    return evidenceId;
  });
}

export function emitNdaaConferenceVehicleProofV1(
  builder: ArtifactBuilderV1,
  proofInput: NdaaConferenceVehicleProofV1,
  parserRunId: string,
): void {
  const proof = ndaaConferenceVehicleProofV1Schema.parse(proofInput);
  const evidenceId = evidenceIdV1({
    stage: 'ndaa_conference',
    kind: 'vehicle_proof',
    sourceSha256: proof.primary.sourceSha256,
    billIds: proof.billIds,
    reportNumber: proof.reportNumber,
  });
  builder.addEvidence({
    evidenceId,
    sourcePdfSha256: proof.primary.sourceSha256,
    parserRunId,
    granularity: 'document_only',
    excerpt: `${proof.billIds.join(', ')} | ${proof.reportNumber}`,
  });
  const factId = factIdV1({ stage: 'ndaa_conference', kind: 'vehicle_proof', proof });
  builder.addSourceFact({
    factId,
    sourcePath: 'document/ndaa-conference-vehicle-proof',
    category: 'metadata',
    requiredForCompleteness: true,
    rawValue: proof,
    evidenceIds: [evidenceId],
  });
  builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ factId, fieldName: NDAA_CONFERENCE_VEHICLE_PROOF_FIELD }),
    sourceFactIds: [factId],
    evidenceIds: [evidenceId],
    confidence: 1,
    fieldName: NDAA_CONFERENCE_VEHICLE_PROOF_FIELD,
    value: proof,
  });
}

export function emitNdaaConferenceBaselineV1(
  builder: ArtifactBuilderV1,
  baseline: StageBaselineFactV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const fiscalYear = baseline.fiscalYear ?? uniqueFiscalYear(table);
  const value = committeeRequestBaselineV1Schema.parse({
    schemaVersion: COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
    stage: 'ndaa_conference',
    authority: 'ndaa_conference_authorization',
    identity: baseline.identity,
    fiscalYear,
    money: money(baseline.value, baseline.unit),
    evidenceIds,
  });
  const factId = factIdV1({
    stage: 'ndaa_conference',
    row: row.rowIndex,
    page: table.page,
    identity: nativeIdentityKeyV1(baseline.identity),
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
    metadata: { nonOwningComparisonFact: true, stage: 'ndaa_conference' },
  });
}

export function emitNdaaConferencePositionV1(
  builder: ArtifactBuilderV1,
  profile: DefenseBudgetStageSourceProfileV1,
  position: StagePositionV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  if (position.field !== 'ndaaConference') {
    throw new Error(`NDAA conference emitter produced prohibited field '${position.field}'`);
  }
  const factId = factIdV1({
    stage: 'ndaa_conference',
    row: row.rowIndex,
    page: table.page,
    identity: nativeIdentityKeyV1(position.identity),
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
  });
  builder.addSourceFact({
    factId,
    sourcePath: sourcePath(table, row, 'ndaa-conference-position'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: { directOrDerived: position.provenance },
    evidenceIds,
  });
  builder.addAssertion({
    assertionKind: 'funding',
    assertionId: assertionIdV1({ factId, field: 'ndaaConference' }),
    sourceFactIds: [factId],
    evidenceIds,
    confidence: position.provenance === 'direct' ? 1 : 0.99,
    identity: position.identity,
    fiscalYear: position.fiscalYear ?? profile.fiscalYear,
    field: 'ndaaConference',
    money: money(position.value, position.unit),
    metadata: {
      stage: 'ndaa_conference',
      profileId: profile.profileId,
      profileHash: stageSourceProfileHashV1(profile),
      directOrDerived: position.provenance,
      physicalPage: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
      ...(position.derivation != null
        ? { derivationBaseline: position.derivation.baseline, derivationChange: position.derivation.change }
        : {}),
    },
  });
}

export function emitNdaaConferenceChamberFactV1(input: {
  builder: ArtifactBuilderV1;
  bundle: NdaaConferenceTableV1;
  row: CongressionalRowV1;
  identity: BudgetLineIdentityV1;
  fiscalYear: number;
  position: StagePositionV1;
  evidenceIds: string[];
}): void {
  const printed = printedConferenceMoneyForRowV1(input.bundle, input.row);
  const byRole = new Map(printed.map((item) => [item.role, item]));
  const printedValue = (role: 'hasc' | 'sasc') => {
    const value = byRole.get(role);
    return value == null
      ? { status: 'NOT_PRINTED' as const }
      : { status: 'PRINTED' as const, money: money(value.value, value.unit), evidenceIds: input.evidenceIds };
  };
  const conferencePrinted = byRole.get('ndaa_conference');
  const request = byRole.get('request_baseline');
  const change = byRole.get('change');
  const conference = conferencePrinted != null
    ? {
        status: 'PRINTED' as const,
        money: money(conferencePrinted.value, conferencePrinted.unit),
        evidenceIds: input.evidenceIds,
      }
    : {
        status: 'DERIVED' as const,
        money: money(input.position.value, input.position.unit),
        baseline: money(input.position.derivation!.baseline, input.position.unit),
        change: money(input.position.derivation!.change, input.position.unit),
        evidenceIds: input.evidenceIds,
      };
  const value = ndaaConferenceChamberPositionsV1Schema.parse({
    schemaVersion: 'ndaa_conference_chamber_positions_v1',
    stage: 'ndaa_conference',
    authority: 'ndaa_conference_authorization',
    identity: input.identity,
    fiscalYear: input.fiscalYear,
    house: printedValue('hasc'),
    senate: printedValue('sasc'),
    conference,
    ...(request != null ? { requestBaseline: money(request.value, request.unit) } : {}),
    ...(change != null ? { change: money(change.value, change.unit) } : {}),
    evidenceIds: input.evidenceIds,
  });
  const factId = factIdV1({
    stage: 'ndaa_conference',
    kind: 'chamber_positions',
    identity: nativeIdentityKeyV1(input.identity),
    fiscalYear: input.fiscalYear,
    page: input.bundle.table.page,
    row: input.row.rowIndex,
  });
  input.builder.addSourceFact({
    factId,
    sourcePath: sourcePath(input.bundle.table, input.row, 'chamber-positions'),
    category: 'money',
    requiredForCompleteness: true,
    rawValue: value,
    evidenceIds: input.evidenceIds,
  });
  input.builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: assertionIdV1({ factId, fieldName: NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD }),
    sourceFactIds: [factId],
    evidenceIds: input.evidenceIds,
    confidence: 1,
    fieldName: NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
    value,
  });
}

export function emitNdaaConferenceStageActionV1(
  builder: ArtifactBuilderV1,
  action: StageActionDraftV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
): void {
  const actionType = actionTypeFor(row, action.amount);
  const amount = signed(actionType, action.amount);
  const actionId = assertionIdV1({
    stage: 'ndaa_conference',
    page: table.page,
    row: row.rowIndex,
    identity: nativeIdentityKeyV1(action.identity),
    actionType,
  });
  const signedMillions = moneyToMillionsString(amount, action.unit);
  const value = committeeStageActionV1Schema.parse({
    schemaVersion: DEFENSE_BUDGET_STAGE_ACTION_SCHEMA_VERSION,
    actionId,
    track: 'authorization',
    stage: 'ndaa_conference',
    authority: 'ndaa_conference_authorization',
    actionType,
    identity: action.identity,
    fiscalYear: action.fiscalYear ?? uniqueFiscalYear(table),
    amount: money(amount, action.unit),
    signedValueMillions: signedMillions,
    rationale: row.finding ?? row.rawLabel,
    evidenceIds,
    direct: true,
  });
  const factId = factIdV1({ actionId, kind: 'ndaa_conference_stage_action' });
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
}

export function omitNdaaConferenceRowV1(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  evidenceIds: string[],
  reason: 'invalid_identity' | 'ambiguous_layout' | 'unsupported_unit' | 'missing_value' | 'unsupported_field',
  severity: 'review' | 'blocking',
  message: string,
): void {
  const factId = factIdV1({ stage: 'ndaa_conference', page: table.page, row: row.rowIndex, reason });
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

function money(value: string, unit: MoneyUnitV1) {
  return {
    originalValue: value,
    originalUnit: unit,
    valueMillions: moneyToMillionsString(value, unit),
  };
}

function uniqueFiscalYear(table: CongressionalTableV1): number {
  const years = [...new Set(table.columns.flatMap((column) => column.fiscalYear == null ? [] : [column.fiscalYear]))];
  if (years.length !== 1) throw new Error('NDAA conference row requires one unambiguous fiscal year');
  return years[0]!;
}

function actionTypeFor(row: CongressionalRowV1, value: string): CommitteeStageActionTypeV1 {
  if (row.semanticKind === 'transfer_in') return 'transfer_in';
  if (row.semanticKind === 'transfer_out') return 'transfer_out';
  if (row.semanticKind === 'rescission') return 'rescission';
  if (row.semanticKind === 'undistributed') return 'undistributed_adjustment';
  if (row.semanticKind === 'general_provision') return 'general_provision';
  return value.startsWith('-') ? 'decrease' : 'increase';
}

function signed(type: CommitteeStageActionTypeV1, value: string): string {
  const canonical = parseCanonicalDecimalString(value);
  const magnitude = canonical.startsWith('-') ? canonical.slice(1) : canonical;
  if (magnitude === '0') return '0';
  return ['decrease', 'transfer_out', 'rescission'].includes(type) ? `-${magnitude}` : magnitude;
}
