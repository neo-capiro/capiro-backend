/** Phase 6 Workstream K — deterministic, write-free appropriations conference composition. */
import {
  ArtifactBuilderV1,
  assertionIdV1,
  evidenceIdV1,
  factIdV1,
  omissionIdV1,
  parserRunIdV1,
} from '../../../contracts/artifact-builders.js';
import { moneyToMillionsString } from '../../../contracts/decimal-string.js';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  ACTION_ROW_KINDS,
  composeDuplicateRowsV1,
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
  type RowMoneyV1,
} from '../../congressional-table-v1.js';
import type { ResolvedBudgetLineBindingV1 } from '../../budget-line-reference-v1.js';
import {
  resolveBudgetLineReferenceV1,
  type LineReferenceResolutionContext,
} from '../../line-reference-resolver.js';
import { emitStageRowsV1 } from '../../stage-row-emitter-v1.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION,
  committeeRequestBaselineV1Schema,
} from '../../authorization/committee-stage-facts-v1.js';
import {
  DEFENSE_BUDGET_STAGE_ACTION_V1_FIELD,
  defenseBudgetStageActionV1Schema,
  type DefenseBudgetStageActionV1,
} from '../actions/defense-budget-stage-action-v1.js';
import { verifyAppropriationsActionsV1 } from '../actions/appropriations-action-verifier-v1.js';
import {
  APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD,
  appropriationsConferenceChamberPositionsV1Schema,
  appropriationsConferenceVehicleProofV1Schema,
  type AppropriationsConferenceVehicleProofV1,
} from './appropriations-conference-facts-v1.js';
import {
  conferenceEmissionTableV1,
  printedConferenceMoneyForRowV1,
  appropriationsConferenceTableV1Schema,
  type AppropriationsConferenceTableV1,
} from './appropriations-conference-table-v1.js';
import {
  appropriationsConferenceProfileHashV1,
  type AppropriationsConferenceSourceProfileV1,
} from './appropriations-conference-source-profile-v1.js';

export interface ComposeAppropriationsConferenceV1Input {
  profile: AppropriationsConferenceSourceProfileV1;
  source: ExtractionSourceV1;
  parserRuns: readonly ParserRunV1[];
  tables: readonly AppropriationsConferenceTableV1[];
  resolutionContext: LineReferenceResolutionContext;
  vehicleProof: AppropriationsConferenceVehicleProofV1;
}

export interface ComposeAppropriationsConferenceV1Result {
  artifact: DefenseBudgetExtractionArtifactV1;
  bindings: ResolvedBudgetLineBindingV1[];
  actionVerification: ReturnType<typeof verifyAppropriationsActionsV1>;
}

function tableKey(table: CongressionalTableV1) {
  return {
    page: table.page,
    printedPage: table.printedPage ?? null,
    headings: table.headings,
    columns: table.columns.map(({ columnIndex, headerText }) => ({ columnIndex, headerText })),
  };
}

function addEvidence(
  builder: ArtifactBuilderV1,
  table: CongressionalTableV1,
  row: CongressionalRowV1,
  parserRunId: string,
): string[] {
  const cells = row.cells.length > 0 ? row.cells : [{ rowIndex: row.rowIndex, columnIndex: -1, rawText: '' }];
  return cells.map((cell) => {
    const id = evidenceIdV1({ stage: 'appropriations_conference', table: tableKey(table), row: row.rowIndex, column: cell.columnIndex, rawText: cell.rawText });
    builder.addEvidence({
      evidenceId: id,
      sourcePdfSha256: table.sourceSha256,
      parserRunId,
      granularity: cell.textSpan != null ? 'text_span' : 'page_only',
      page: table.page,
      ...(table.printedPage != null ? { printedPage: table.printedPage } : {}),
      ...(cell.textSpan != null ? { textSpan: cell.textSpan } : {}),
      rowLabel: row.rawLabel,
      columnLabel: table.columns.find((column) => column.columnIndex === cell.columnIndex)?.headerText,
      ...(cell.rawText ? { excerpt: cell.rawText } : {}),
    });
    return id;
  });
}

function exactFiscalYear(table: CongressionalTableV1, fallback: number): number {
  const years = [...new Set(table.columns.flatMap((column) => column.fiscalYear == null ? [] : [column.fiscalYear]))];
  return years.length === 1 ? years[0]! : fallback;
}

function actionMoney(table: CongressionalTableV1, row: CongressionalRowV1): RowMoneyV1 | undefined {
  const values = rowMoneyV1(table, row);
  return values.find((item) => item.semantic === 'change') ?? values.find((item) => item.semantic === 'transfer_amount') ?? values.find((item) => item.semantic === 'rescission_amount');
}

function actionType(row: CongressionalRowV1, amount?: RowMoneyV1): DefenseBudgetStageActionV1['actionType'] {
  if (row.semanticKind === 'transfer_in') return 'transfer_in';
  if (row.semanticKind === 'transfer_out') return 'transfer_out';
  if (row.semanticKind === 'rescission') return 'rescission';
  if (row.semanticKind === 'undistributed') return 'undistributed_adjustment';
  if (row.semanticKind === 'general_provision') return 'general_provision';
  return amount?.value.startsWith('-') ? 'decrease' : 'increase';
}

function signed(type: DefenseBudgetStageActionV1['actionType'], value: string): string {
  const magnitude = value.startsWith('-') ? value.slice(1) : value;
  if (magnitude === '0') return '0';
  return ['decrease', 'transfer_out', 'rescission'].includes(type) ? `-${magnitude}` : magnitude;
}

function emitAction(input: {
  builder: ArtifactBuilderV1;
  profile: AppropriationsConferenceSourceProfileV1;
  table: CongressionalTableV1;
  row: CongressionalRowV1;
  identity?: BudgetLineIdentityV1;
  evidenceIds: string[];
}): DefenseBudgetStageActionV1 | null {
  const amount = actionMoney(input.table, input.row);
  const type = actionType(input.row, amount);
  if (amount == null && !['general_provision', 'restriction', 'directive', 'reporting_requirement', 'other'].includes(type)) return null;
  const packageScope = input.row.reference.referenceKind === 'package_scope' ? input.row.reference.scope : undefined;
  const actionId = assertionIdV1({ stage: 'appropriations_conference', table: tableKey(input.table), row: input.row.rowIndex, type, identity: input.identity ?? packageScope ?? input.row.rawLabel });
  const action = defenseBudgetStageActionV1Schema.parse({
    schemaVersion: 'defense_budget_stage_action_v1',
    actionId,
    track: 'appropriations',
    stage: 'appropriations_conference',
    authority: 'appropriations_conference',
    vehicleClass: 'conference_report',
    actionType: type,
    ...(input.identity != null ? { identity: input.identity } : {}),
    ...(packageScope != null ? { packageScope } : {}),
    fiscalYear: amount?.fiscalYear ?? exactFiscalYear(input.table, input.profile.stageProfile.fiscalYear),
    ...(amount != null ? {
      amount: {
        originalValue: amount.value.startsWith('-') ? amount.value.slice(1) : amount.value,
        originalUnit: amount.unit,
        valueMillions: moneyToMillionsString(amount.value.startsWith('-') ? amount.value.slice(1) : amount.value, amount.unit),
      },
      signedValueMillions: moneyToMillionsString(signed(type, amount.value), amount.unit),
    } : {}),
    direction: type === 'transfer_in' ? 'in' : type === 'transfer_out' ? 'out' : type === 'decrease' || type === 'rescission' ? 'decrease' : type === 'increase' ? 'increase' : 'neutral',
    rationale: input.row.finding ?? input.row.rawLabel,
    evidenceIds: input.evidenceIds,
    languageEvidenceIds: [],
    directOrDerived: 'direct',
  });
  const sourceFactId = factIdV1({ actionId, kind: 'appropriations_conference_action' });
  input.builder.addSourceFact({
    factId: sourceFactId,
    sourcePath: `page:${input.table.page}/row:${input.row.rowIndex}/stage-action`,
    category: amount == null ? 'text' : 'money',
    requiredForCompleteness: true,
    rawValue: action,
    evidenceIds: input.evidenceIds,
  });
  input.builder.addAssertion({
    assertionKind: 'document_fact',
    assertionId: actionId,
    sourceFactIds: [sourceFactId],
    evidenceIds: input.evidenceIds,
    confidence: 1,
    fieldName: DEFENSE_BUDGET_STAGE_ACTION_V1_FIELD,
    value: action,
  });
  return action;
}

function assertBinding(input: ComposeAppropriationsConferenceV1Input, proof: AppropriationsConferenceVehicleProofV1): void {
  const profile = input.profile.stageProfile;
  if (profile.track !== 'appropriations' || profile.stage !== 'appropriations_conference' || profile.authority !== 'appropriations_conference') {
    throw new Error('appropriations conference requires the appropriations conference stage profile');
  }
  if (input.source.authority !== 'appropriations_conference' || input.source.exhibit !== 'conference_report') {
    throw new Error('appropriations conference source has wrong track/vehicle authority');
  }
  if (proof.track !== 'appropriations' || proof.stage !== 'appropriations_conference') throw new Error('appropriations conference proof has wrong track');
  if (proof.fiscalYear !== profile.fiscalYear || input.source.fiscalYear !== profile.fiscalYear) throw new Error('appropriations conference fiscal-year mismatch');
  if (profile.billId !== proof.billId) throw new Error('appropriations conference bill mismatch');
  if ((profile.reportNumber ?? null) !== (proof.reportNumber ?? null)) throw new Error('appropriations conference report-number mismatch');
  if (proof.primary.manifestDocumentKey !== input.source.manifestDocumentKey) throw new Error('appropriations conference primary manifest mismatch');
  if (proof.primary.sourceDocumentId !== (input.source.sourceDocumentId ?? input.source.manifestDocumentKey)) throw new Error('appropriations conference source-document mismatch');
  if (proof.primary.sourceSha256 !== input.source.sourcePdfSha256) throw new Error('appropriations conference source SHA mismatch');
  if (proof.vehicleStructure !== input.profile.vehicleStructure || proof.division !== input.profile.division || proof.title !== input.profile.title) throw new Error('appropriations conference vehicle structure mismatch');
}

export function composeAppropriationsConferenceV1(input: ComposeAppropriationsConferenceV1Input): ComposeAppropriationsConferenceV1Result {
  const proof = appropriationsConferenceVehicleProofV1Schema.parse(input.vehicleProof);
  assertBinding(input, proof);
  const builder = new ArtifactBuilderV1(input.source);
  const fallbackRun = {
    parserRunId: parserRunIdV1({ source: input.source.sourcePdfSha256, profile: input.profile.stageProfile.profileId }),
    method: 'manual' as const,
    parserVersion: 'appropriations-conference-composer-v1',
    parserConfigSha256: appropriationsConferenceProfileHashV1(input.profile),
    inputSourceSha256: input.source.sourcePdfSha256,
    outputArtifactSha256: input.source.sourcePdfSha256,
  };
  for (const run of input.parserRuns) builder.addParserRun(run);
  const runId = input.parserRuns[0]?.parserRunId ?? fallbackRun.parserRunId;
  const actions: DefenseBudgetStageActionV1[] = [];
  const bindings: ResolvedBudgetLineBindingV1[] = [];

  const proofFactId = factIdV1({ kind: APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD, proof });
  builder.addSourceFact({ factId: proofFactId, sourcePath: 'vehicle-proof', category: 'metadata', requiredForCompleteness: true, rawValue: proof, evidenceIds: [] });
  builder.addAssertion({ assertionKind: 'document_fact', assertionId: assertionIdV1({ proofFactId }), sourceFactIds: [proofFactId], evidenceIds: [], confidence: 1, fieldName: APPROPRIATIONS_CONFERENCE_VEHICLE_PROOF_FIELD, value: proof });

  for (const rawBundle of input.tables) {
    const bundle = appropriationsConferenceTableV1Schema.parse(rawBundle);
    const table = bundle.table;
    if (table.profileId !== input.profile.stageProfile.profileId || table.sourceSha256 !== input.source.sourcePdfSha256 || table.sourceDocumentId !== (input.source.sourceDocumentId ?? input.source.manifestDocumentKey)) {
      throw new Error('appropriations conference table source binding mismatch');
    }
    const emissionTable = conferenceEmissionTableV1(bundle);
    const duplicateGroups = composeDuplicateRowsV1(emissionTable, { allowBaselinePlusChange: false });
    const conflictRows = new Set<number>();
    const secondary = new Set<number>();
    const grouped = new Map<number, CongressionalRowV1[]>();
    for (const group of duplicateGroups) {
      if (group.rows.length < 2) continue;
      const rows = [...group.rows].sort((a, b) => a.rowIndex - b.rowIndex);
      if (group.conflict != null) rows.forEach((row) => conflictRows.add(row.rowIndex));
      else if (group.agreedValue != null) {
        grouped.set(rows[0]!.rowIndex, rows);
        rows.slice(1).forEach((row) => secondary.add(row.rowIndex));
      }
    }
    const evidenceByRow = new Map<number, string[]>();
    for (const row of table.rows) evidenceByRow.set(row.rowIndex, addEvidence(builder, table, row, runId));

    for (const row of table.rows) {
      const evidenceIds = (grouped.get(row.rowIndex) ?? [row]).flatMap((item) => evidenceByRow.get(item.rowIndex) ?? []);
      if (conflictRows.has(row.rowIndex)) {
        const factId = factIdV1({ stage: 'appropriations_conference', page: table.page, row: row.rowIndex, kind: 'duplicate_conflict' });
        builder.addSourceFact({ factId, sourcePath: `page:${table.page}/row:${row.rowIndex}/duplicate-conflict`, category: 'metadata', requiredForCompleteness: true, rawValue: row.rawLabel, evidenceIds });
        builder.addOmission({ omissionId: omissionIdV1({ factId }), sourceFactId: factId, reason: 'ambiguous_layout', severity: 'blocking', message: 'conflicting appropriations conference rows are not auto-resolved' });
        continue;
      }
      if (secondary.has(row.rowIndex)) continue;

      const isAction = ACTION_ROW_KINDS.includes(row.semanticKind) || row.semanticKind === 'general_provision';
      let binding: ResolvedBudgetLineBindingV1 | null = null;
      if (row.reference.referenceKind !== 'package_scope') {
        binding = resolveBudgetLineReferenceV1(row.reference, input.resolutionContext);
        binding.supportingEvidenceIds = evidenceIds;
        bindings.push(binding);
      }
      if (isAction) {
        const action = emitAction({ builder, profile: input.profile, table, row, ...(binding?.status === 'accepted' && binding.targetIdentity != null ? { identity: binding.targetIdentity } : {}), evidenceIds });
        if (action != null) actions.push(action);
        continue;
      }

      if (binding == null || binding.status !== 'accepted' || binding.targetIdentity == null) {
        const factId = factIdV1({ stage: 'appropriations_conference', page: table.page, row: row.rowIndex, kind: 'identity_omission' });
        builder.addSourceFact({ factId, sourcePath: `page:${table.page}/row:${row.rowIndex}/identity-omission`, category: 'identity', requiredForCompleteness: true, rawValue: { status: binding?.status ?? 'package_scope', label: row.rawLabel }, evidenceIds });
        builder.addOmission({ omissionId: omissionIdV1({ factId }), sourceFactId: factId, reason: 'invalid_identity', severity: binding?.status === 'candidate' ? 'review' : 'blocking', message: 'appropriations conference row lacks an accepted native identity' });
        continue;
      }

      const oneRowTable: CongressionalTableV1 = { ...emissionTable, rows: [row] };
      const emission = emitStageRowsV1({ profile: input.profile.stageProfile, table: oneRowTable, bindingsByRowIndex: new Map([[row.rowIndex, binding]]) });
      for (const baseline of emission.baselines) {
        const value = committeeRequestBaselineV1Schema.parse({ schemaVersion: COMMITTEE_REQUEST_BASELINE_SCHEMA_VERSION, stage: 'appropriations_conference', authority: 'appropriations_conference', identity: baseline.identity, fiscalYear: baseline.fiscalYear ?? input.profile.stageProfile.fiscalYear, money: { originalValue: baseline.value, originalUnit: baseline.unit, valueMillions: moneyToMillionsString(baseline.value, baseline.unit) }, evidenceIds });
        const factId = factIdV1({ stage: 'appropriations_conference', row: row.rowIndex, kind: 'request_baseline', identity: baseline.identity });
        builder.addSourceFact({ factId, sourcePath: `page:${table.page}/row:${row.rowIndex}/request-baseline`, category: 'money', requiredForCompleteness: false, rawValue: value, evidenceIds });
        builder.addAssertion({ assertionKind: 'document_fact', assertionId: assertionIdV1({ factId, fieldName: COMMITTEE_REQUEST_BASELINE_FIELD }), sourceFactIds: [factId], evidenceIds, confidence: 1, fieldName: COMMITTEE_REQUEST_BASELINE_FIELD, value, metadata: { nonOwningComparisonFact: true, stage: 'appropriations_conference' } });
      }
      for (const position of emission.positions) {
        if (position.field !== 'conference') throw new Error(`appropriations conference emitted prohibited field ${position.field}`);
        const factId = factIdV1({ stage: 'appropriations_conference', row: row.rowIndex, identity: position.identity, fiscalYear: position.fiscalYear ?? input.profile.stageProfile.fiscalYear });
        builder.addSourceFact({ factId, sourcePath: `page:${table.page}/row:${row.rowIndex}/conference-position`, category: 'money', requiredForCompleteness: true, rawValue: { directOrDerived: position.provenance }, evidenceIds });
        builder.addAssertion({ assertionKind: 'funding', assertionId: assertionIdV1({ factId, field: 'conference' }), sourceFactIds: [factId], evidenceIds, confidence: position.provenance === 'direct' ? 1 : 0.99, identity: position.identity, fiscalYear: position.fiscalYear ?? input.profile.stageProfile.fiscalYear, field: 'conference', money: { originalValue: position.value, originalUnit: position.unit, valueMillions: moneyToMillionsString(position.value, position.unit) }, metadata: { track: 'appropriations', stage: 'appropriations_conference', vehicleStructure: input.profile.vehicleStructure, ...(input.profile.division != null ? { division: input.profile.division } : {}), ...(input.profile.title != null ? { title: input.profile.title } : {}) } });

        const printed = printedConferenceMoneyForRowV1(bundle, row);
        const conference = printed.find((item) => item.role === 'conference');
        if (conference == null) throw new Error('conference position must be printed; inferred compromise is forbidden');
        const toPosition = (role: 'hac_d' | 'sac_d') => {
          const item = printed.find((value) => value.role === role);
          return item == null ? { status: 'NOT_PRINTED' as const } : { status: 'PRINTED' as const, money: { originalValue: item.value, originalUnit: item.unit, valueMillions: moneyToMillionsString(item.value, item.unit) } };
        };
        const chamberFact = appropriationsConferenceChamberPositionsV1Schema.parse({ schemaVersion: 'appropriations_conference_chamber_positions_v1', identity: position.identity, fiscalYear: position.fiscalYear ?? input.profile.stageProfile.fiscalYear, hacd: toPosition('hac_d'), sacd: toPosition('sac_d'), conference: { status: 'PRINTED', money: { originalValue: conference.value, originalUnit: conference.unit, valueMillions: moneyToMillionsString(conference.value, conference.unit) } }, evidenceIds });
        const chamberFactId = factIdV1({ field: APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD, identity: position.identity, fiscalYear: chamberFact.fiscalYear, page: table.page });
        builder.addSourceFact({ factId: chamberFactId, sourcePath: `page:${table.page}/row:${row.rowIndex}/chamber-positions`, category: 'money', requiredForCompleteness: true, rawValue: chamberFact, evidenceIds });
        builder.addAssertion({ assertionKind: 'document_fact', assertionId: assertionIdV1({ chamberFactId }), sourceFactIds: [chamberFactId], evidenceIds, confidence: 1, fieldName: APPROPRIATIONS_CONFERENCE_CHAMBER_POSITIONS_FIELD, value: chamberFact });
      }
      for (const omission of emission.omissions) {
        const factId = factIdV1({ stage: 'appropriations_conference', row: row.rowIndex, omission: omission.reason });
        builder.addSourceFact({ factId, sourcePath: `page:${table.page}/row:${row.rowIndex}/omission`, category: 'metadata', requiredForCompleteness: true, rawValue: omission.reason, evidenceIds });
        builder.addOmission({ omissionId: omissionIdV1({ factId }), sourceFactId: factId, reason: omission.reason === 'undeclared_unit' ? 'unsupported_unit' : 'missing_value', severity: 'blocking', message: `appropriations conference omitted row: ${omission.reason}` });
      }
    }
  }

  if (input.parserRuns.length === 0) builder.addParserRunCoveringAddedEvidence(fallbackRun);
  const artifact = builder.finalize();
  return { artifact, bindings, actionVerification: verifyAppropriationsActionsV1({ actions }) };
}
