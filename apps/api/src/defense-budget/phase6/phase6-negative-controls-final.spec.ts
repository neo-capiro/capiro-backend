import { ArtifactBuilderV1 } from '../contracts/artifact-builders.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  PHASE6_NEGATIVE_CONTROL_IDS,
  scanPhase6ArchitectureSourceV1,
} from './phase6-closeout-gates-v1.js';
import { phase6NativeProjectionV1Schema } from './phase6-native-projection-v1.js';
import { certifyPhase6CycleV1 } from './phase6-cycle-certification-v1.js';
import { createHascSourceProfileV1 } from '../stages/authorization/hasc-source-profile-v1.js';
import {
  NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
  ndaaConferenceChamberPositionsV1Schema,
} from '../stages/authorization/ndaa-conference/ndaa-conference-facts-v1.js';
import {
  composeDuplicateRowsV1,
  deriveAbsolutePositionV1,
  rowMoneyV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from '../stages/congressional-table-v1.js';
import { bindingMachinePassAllowed } from '../stages/budget-line-reference-v1.js';
import { resolveBudgetLineReferenceV1 } from '../stages/line-reference-resolver.js';
import { emitStageRowsV1 } from '../stages/stage-row-emitter-v1.js';
import {
  defenseBudgetStageActionV1Schema,
  type DefenseBudgetStageActionV1,
} from '../stages/appropriations/actions/defense-budget-stage-action-v1.js';
import { verifyAppropriationsActionsV1 } from '../stages/appropriations/actions/appropriations-action-verifier-v1.js';
import { buildVerifiedStageActionProjectionPlanV1 } from '../stages/appropriations/actions/appropriations-action-projection-v1.js';
import { appropriationsConferenceVehicleProofV1Schema } from '../stages/appropriations/conference/appropriations-conference-facts-v1.js';
import { defenseBudgetEnactmentProofV1Schema } from '../stages/enacted/enactment-proof-v1.js';
import {
  composeExecutionRecordV1,
  composeReprogrammingEventV1,
} from '../stages/post-enactment/reprogramming-execution-v1.js';
import { NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE } from '../verification/rules/comparison/ndaa-conference-chamber.rules.js';
import type { VerificationContextV1 } from '../verification/verification-input-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const PE = { lineKind: 'RDTE_PE' as const, peCode: '0605053A' };
const PE2 = { lineKind: 'RDTE_PE' as const, peCode: '0603270A' };
const PROCUREMENT = {
  lineKind: 'PROCUREMENT_BLIN' as const,
  code: 'W12002',
  account: '2035A',
  component: 'ARMY' as const,
};
const money = (value: string, unit: 'dollars' | 'thousands' | 'millions' = 'millions') => ({
  originalValue: value,
  originalUnit: unit,
  valueMillions: unit === 'millions' ? value : unit === 'thousands' ? String(Number(value) / 1000) : String(Number(value) / 1_000_000),
});

const HASC_PROFILE = createHascSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'H. Rept. 119-715',
  sourceDocumentKeys: ['hasc-fy2027'],
});

function projectionRaw(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'phase6_native_projection_v1',
    projectionId: 'p1',
    naturalKey: 'nk1',
    idempotencyKey: 'idem1',
    projectionKind: 'stage_position',
    verificationCandidateId: 'vc1',
    verificationRunId: 'vr1',
    artifactId: 'a1',
    artifactContentSha256: SHA,
    sourceDocumentId: 'doc1',
    sourcePdfSha256: SHA,
    sourceProfileHash: SHA,
    nativeIdentityHash: SHA,
    track: 'appropriations',
    stage: 'hac_d',
    fundingField: 'hacDMark',
    money: money('10'),
    directOrDerived: 'direct',
    evidenceIds: ['e1'],
    bindingStatus: 'accepted',
    projectionStatus: 'verified',
    payload: {},
    canonicalWriteAllowed: false,
    ...overrides,
  };
}

function cycle(outcome: 'PASS' | 'FAIL' | 'NOT_RUN' = 'PASS') {
  return {
    schemaVersion: 'phase6_cycle_certification_input_v1' as const,
    cycleId: 'fy2027-defense',
    fiscalYear: FY,
    manifestHash: SHA,
    documents: [
      { documentKey: 'required', required: true, status: 'present' as const, sourceProofStatus: 'PASS' as const },
    ],
    projections: [phase6NativeProjectionV1Schema.parse(projectionRaw())],
    comparisons: [{ code: 'required-comparison', outcome, required: true }],
    lineFamilyCoverage: { RDTE_PE: 1 },
    bindingCounts: { accepted: 1, candidate: 0, unresolved: 0, conflicting: 0 },
    enactmentProofCoverage: { direct: 0, incorporated: 0, unresolved: 0, blocked: 0 },
    reprogrammingCoverage: 0,
    executionCoverage: 0,
    parserStats: { localPages: 1, paidPages: 0, cacheHits: 0 },
  };
}

function row(
  semanticKind: CongressionalRowV1['semanticKind'],
  values: Array<{ columnIndex: number; rawText: string; value?: string }>,
  rawLabel = 'PE 0605053A Ground Robotics',
): CongressionalRowV1 {
  return {
    rowIndex: 0,
    rawLabel,
    reference: { referenceKind: 'pe_code', peCode: PE.peCode, rowTitle: 'Ground Robotics' },
    semanticKind,
    cells: values.map((value) => ({ rowIndex: 0, ...value })),
  };
}

function table(input: {
  row: CongressionalRowV1;
  unit?: 'dollars' | 'thousands' | 'millions';
  semantics: Array<{
    columnIndex: number;
    headerText: string;
    moneySemantic?: 'request_baseline' | 'change' | 'authorized_total' | 'appropriated_total';
    isQuantity?: boolean;
  }>;
}): CongressionalTableV1 {
  return {
    schemaVersion: 'congressional_table_v1',
    profileId: HASC_PROFILE.profileId,
    sourceDocumentId: 'doc',
    sourceSha256: SHA,
    page: 1,
    headings: ['TITLE IV'],
    ...(input.unit != null ? { declaredUnit: input.unit } : {}),
    columns: input.semantics.map((column) => ({
      columnIndex: column.columnIndex,
      headerText: column.headerText,
      ...(column.moneySemantic != null
        ? { moneySemantic: column.moneySemantic, fiscalYear: FY }
        : {}),
      isQuantity: column.isQuantity ?? false,
    })),
    rows: [input.row],
  };
}

function acceptedBinding() {
  return {
    reference: { referenceKind: 'pe_code' as const, peCode: PE.peCode },
    targetIdentity: PE,
    candidates: [PE],
    basis: 'exact_identity' as const,
    confidence: 1,
    status: 'accepted' as const,
    supportingEvidenceIds: [],
  };
}

function action(overrides: Partial<DefenseBudgetStageActionV1> = {}): DefenseBudgetStageActionV1 {
  return defenseBudgetStageActionV1Schema.parse({
    schemaVersion: 'defense_budget_stage_action_v1',
    actionId: 'action-1',
    track: 'appropriations',
    stage: 'hac_d',
    authority: 'hacd_appropriations',
    vehicleClass: 'committee_report',
    actionType: 'increase',
    identity: PE,
    fiscalYear: FY,
    amount: money('5'),
    signedValueMillions: '5',
    direction: 'increase',
    evidenceIds: ['e1'],
    languageEvidenceIds: [],
    directOrDerived: 'direct',
    ...overrides,
  });
}

function evidenceArtifact(page: number | undefined): DefenseBudgetExtractionArtifactV1 {
  const source: ExtractionSourceV1 = {
    manifestDocumentKey: 'hasc-fy2027',
    sourceDocumentId: 'doc',
    sourcePdfSha256: SHA,
    sourceLocator: 'fixture://hasc.pdf',
    fiscalYear: FY,
    family: 'committee',
    exhibit: 'committee_report',
    authority: 'hasc',
    component: 'DW',
    budgetCycle: 'fy2027',
    documentType: 'committee_report',
  };
  const run: ParserRunV1 = {
    parserRunId: 'run-1',
    method: 'deterministic_pdfplumber',
    parserVersion: 'test',
    parserConfigSha256: 'b'.repeat(64),
    inputSourceSha256: SHA,
    outputArtifactSha256: 'c'.repeat(64),
    pageRanges: [{ startPage: 1, endPage: 1 }],
  };
  const builder = new ArtifactBuilderV1(source).addParserRun(run);
  builder.addEvidence({
    evidenceId: 'e1',
    sourcePdfSha256: SHA,
    parserRunId: run.parserRunId,
    granularity: 'page_only',
    ...(page != null ? { page } : {}),
  });
  return builder.finalize();
}

function fundingReference(field: 'hascMark' | 'sascMark', value: string, artifactId: string) {
  return {
    schemaVersion: 'defense_budget_extraction_v1',
    artifactId,
    contentSha256: SHA,
    source: { manifestDocumentKey: artifactId, sourcePdfSha256: SHA, fiscalYear: FY },
    assertions: [
      {
        assertionKind: 'funding',
        assertionId: `${artifactId}-funding`,
        sourceFactIds: [],
        evidenceIds: [],
        confidence: 1,
        identity: PE,
        fiscalYear: FY,
        field,
        money: money(value),
      },
    ],
  } as unknown as DefenseBudgetExtractionArtifactV1;
}

function ndaaDisagreementContext(): VerificationContextV1 {
  const value = ndaaConferenceChamberPositionsV1Schema.parse({
    schemaVersion: 'ndaa_conference_chamber_positions_v1',
    stage: 'ndaa_conference',
    authority: 'ndaa_conference_authorization',
    identity: PE,
    fiscalYear: FY,
    house: { status: 'PRINTED', money: money('100'), evidenceIds: ['h-e'] },
    senate: { status: 'PRINTED', money: money('120'), evidenceIds: ['s-e'] },
    conference: { status: 'PRINTED', money: money('110'), evidenceIds: ['c-e'] },
    evidenceIds: ['c-e'],
  });
  const candidate = {
    artifactId: 'ndaa-conf',
    assertions: [
      {
        assertionKind: 'document_fact',
        assertionId: 'conference-positions',
        sourceFactIds: [],
        evidenceIds: ['c-e'],
        confidence: 1,
        fieldName: NDAA_CONFERENCE_CHAMBER_POSITIONS_FIELD,
        value,
      },
    ],
  } as unknown as DefenseBudgetExtractionArtifactV1;
  return {
    verificationRunId: 'vr-ndaa',
    candidateId: 'candidate-ndaa',
    policy: {
      requiredComparisonRules: ['ndaa_conference_chamber_reference'],
      reviewComparisonRules: [],
    },
    input: {
      artifact: candidate,
      referenceArtifacts: [
        fundingReference('hascMark', '100', 'hasc-ref'),
        fundingReference('sascMark', '120', 'sasc-ref'),
      ],
      referenceArtifactsFindings: [],
    },
  } as unknown as VerificationContextV1;
}

describe('Phase 6 Workstream O — exact mandatory 24 negative controls', () => {
  it('pins the plan-defined NC01–NC24 registry exactly', () => {
    expect(PHASE6_NEGATIVE_CONTROL_IDS).toEqual([
      'last_numeric_value_treated_as_mark',
      'last_wins_duplicate_dedupe',
      'hasc_source_writes_request',
      'authorization_field_mapped_to_appropriations',
      'title_only_line_binding_accepted',
      'missing_procurement_account_accepted',
      'missing_page_evidence_accepted',
      'unit_guessed_from_magnitude',
      'adjustment_treated_as_absolute_total',
      'absolute_total_treated_as_adjustment',
      'hasc_sasc_disagreement_auto_resolved',
      'ndaa_conference_mapped_to_conference',
      'hacd_sacd_fields_swapped',
      'missing_appropriations_conference_comparison_passes',
      'public_law_label_alone_creates_enacted',
      'incorporated_statement_without_incorporation_proof',
      'continuing_resolution_full_year_enacted',
      'rescission_sign_reversed',
      'transfer_direction_lost_through_silent_netting',
      'transfer_amount_mapped_as_reprogrammed_total',
      'obligations_outlays_conflated',
      'stale_superseded_vehicle_proof_accepted',
      'candidate_line_binding_machine_passes',
      'canonical_writer_imported',
    ]);
  });

  it('NC01 last numeric value cannot become the mark', () => {
    const t = table({
      unit: 'millions',
      semantics: [
        { columnIndex: 0, headerText: 'PE' },
        { columnIndex: 1, headerText: 'Request', moneySemantic: 'request_baseline' },
        { columnIndex: 2, headerText: 'Authorized', moneySemantic: 'authorized_total' },
        { columnIndex: 3, headerText: 'Quantity', isQuantity: true },
      ],
      row: row('absolute_position', [
        { columnIndex: 0, rawText: 'PE' },
        { columnIndex: 1, rawText: '100', value: '100' },
        { columnIndex: 2, rawText: '125', value: '125' },
        { columnIndex: 3, rawText: '999', value: '999' },
      ]),
    });
    expect(t.rows[0]!.cells.at(-1)!.value).toBe('999');
    expect(deriveAbsolutePositionV1(t, t.rows[0]!, { allowBaselinePlusChange: true })).toMatchObject({
      status: 'direct',
      value: '125',
    });
  });

  it('NC02 conflicting duplicates cannot last-wins dedupe', () => {
    const base = table({
      unit: 'millions',
      semantics: [
        { columnIndex: 0, headerText: 'PE' },
        { columnIndex: 1, headerText: 'Authorized', moneySemantic: 'authorized_total' },
      ],
      row: row('absolute_position', [
        { columnIndex: 0, rawText: 'PE' },
        { columnIndex: 1, rawText: '10', value: '10' },
      ]),
    });
    const conflicting = {
      ...base,
      rows: [
        base.rows[0]!,
        { ...base.rows[0]!, rowIndex: 1, cells: [{ rowIndex: 1, columnIndex: 0, rawText: 'PE' }, { rowIndex: 1, columnIndex: 1, rawText: '11', value: '11' }] },
      ],
    };
    expect(composeDuplicateRowsV1(conflicting, { allowBaselinePlusChange: true })[0]!.conflict).toBeDefined();
    const clean = {
      ...conflicting,
      rows: [conflicting.rows[0]!, { ...conflicting.rows[1]!, cells: [{ rowIndex: 1, columnIndex: 0, rawText: 'PE' }, { rowIndex: 1, columnIndex: 1, rawText: '10', value: '10' }] }],
    };
    expect(composeDuplicateRowsV1(clean, { allowBaselinePlusChange: true })[0]!.agreedValue).toBe('10');
  });

  it('NC03 HASC cannot own request', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ track: 'authorization', stage: 'hasc', fundingField: 'request' }))).toThrow(/hascMark/);
    const t = table({
      unit: 'millions',
      semantics: [
        { columnIndex: 0, headerText: 'PE' },
        { columnIndex: 1, headerText: 'Request', moneySemantic: 'request_baseline' },
        { columnIndex: 2, headerText: 'Authorized', moneySemantic: 'authorized_total' },
      ],
      row: row('absolute_position', [
        { columnIndex: 0, rawText: 'PE' },
        { columnIndex: 1, rawText: '100', value: '100' },
        { columnIndex: 2, rawText: '125', value: '125' },
      ]),
    });
    const emitted = emitStageRowsV1({
      profile: HASC_PROFILE,
      table: t,
      bindingsByRowIndex: new Map([[0, acceptedBinding()]]),
    });
    expect(emitted.positions).toEqual([expect.objectContaining({ field: 'hascMark', value: '125' })]);
    expect(emitted.baselines).toEqual([expect.objectContaining({ comparisonOnly: true, value: '100' })]);
  });

  it('NC04 authorization field cannot map to appropriations', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ track: 'authorization', stage: 'hasc', fundingField: 'hacDMark' }))).toThrow(/hascMark/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ track: 'authorization', stage: 'hasc', fundingField: 'hascMark' }))).not.toThrow();
  });

  it('NC05 title-only line binding remains candidate', () => {
    const binding = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: 'UNKNOWN', rowTitle: 'Robotics and Applique Systems' },
      {
        fiscalYear: FY,
        profileId: 'sacd',
        index: [{ identity: PROCUREMENT, manifestDocumentKey: 'p1', title: 'Robotics and Applique Systems' }],
      },
    );
    expect(binding.status).toBe('candidate');
    expect(bindingMachinePassAllowed(binding)).toBe(false);
  });

  it('NC06 procurement line without account cannot be accepted', () => {
    const missing = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: 'W12002', component: 'ARMY' },
      { fiscalYear: FY, profileId: 'hacd', index: [{ identity: PROCUREMENT, manifestDocumentKey: 'p1' }] },
    );
    expect(missing.status).not.toBe('accepted');
    const exact = resolveBudgetLineReferenceV1(
      { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' },
      { fiscalYear: FY, profileId: 'hacd', index: [{ identity: PROCUREMENT, manifestDocumentKey: 'p1' }] },
    );
    expect(exact.status).toBe('accepted');
  });

  it('NC07 page evidence without a page is rejected', () => {
    expect(() => evidenceArtifact(undefined)).toThrow(/page/i);
    expect(() => evidenceArtifact(1)).not.toThrow();
  });

  it('NC08 money unit is never guessed from magnitude', () => {
    const withoutUnit = table({
      semantics: [{ columnIndex: 0, headerText: 'PE' }, { columnIndex: 1, headerText: 'Authorized', moneySemantic: 'authorized_total' }],
      row: row('absolute_position', [{ columnIndex: 0, rawText: 'PE' }, { columnIndex: 1, rawText: '125000000', value: '125000000' }]),
    });
    expect(rowMoneyV1(withoutUnit, withoutUnit.rows[0]!)).toEqual([]);
    expect(rowMoneyV1({ ...withoutUnit, declaredUnit: 'dollars' }, withoutUnit.rows[0]!)[0]!.unit).toBe('dollars');
  });

  it('NC09 adjustment cannot become an absolute total', () => {
    const t = table({
      unit: 'millions',
      semantics: [{ columnIndex: 0, headerText: 'PE' }, { columnIndex: 1, headerText: 'Change', moneySemantic: 'change' }],
      row: row('adjustment', [{ columnIndex: 0, rawText: 'PE' }, { columnIndex: 1, rawText: '5', value: '5' }]),
    });
    const emitted = emitStageRowsV1({ profile: HASC_PROFILE, table: t, bindingsByRowIndex: new Map([[0, acceptedBinding()]]) });
    expect(emitted.positions).toHaveLength(0);
    expect(emitted.actions).toHaveLength(1);
  });

  it('NC10 absolute total cannot be treated as an adjustment', () => {
    const bad = table({
      unit: 'millions',
      semantics: [{ columnIndex: 0, headerText: 'PE' }, { columnIndex: 1, headerText: 'Authorized', moneySemantic: 'authorized_total' }],
      row: row('adjustment', [{ columnIndex: 0, rawText: 'PE' }, { columnIndex: 1, rawText: '125', value: '125' }]),
    });
    const blocked = emitStageRowsV1({ profile: HASC_PROFILE, table: bad, bindingsByRowIndex: new Map([[0, acceptedBinding()]]) });
    expect(blocked.positions).toHaveLength(0);
    expect(blocked.actions).toHaveLength(0);
    expect(blocked.omissions[0]?.reason).toBe('row_not_interpretable');
    const clean = emitStageRowsV1({ profile: HASC_PROFILE, table: { ...bad, rows: [{ ...bad.rows[0]!, semanticKind: 'absolute_position' }] }, bindingsByRowIndex: new Map([[0, acceptedBinding()]]) });
    expect(clean.positions[0]?.value).toBe('125');
  });

  it('NC11 HASC/SASC disagreement remains explicit and is never auto-resolved', () => {
    const result = NDAA_CONFERENCE_CHAMBER_REFERENCE_RULE.execute(ndaaDisagreementContext());
    expect(result.check?.outcome).toBe('PASS');
    // Assert the exact recorded values, not substrings of the serialized details:
    // the senate referenceValue "120" contains "20", so a substring check passes
    // even when the chamber delta has been silently collapsed to zero.
    const row = (result.check?.details as Record<string, Record<string, unknown>> | undefined)?.[
      'conference-positions'
    ];
    expect(row).toBeDefined();
    expect(row?.houseVsSenateDelta).toBe('20');
    expect((row?.house as Record<string, unknown>).conferenceValue).toBe('110');
    expect((row?.senate as Record<string, unknown>).conferenceValue).toBe('110');
  });

  it('NC12 NDAA conference cannot map to appropriations conference field', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ track: 'authorization', stage: 'ndaa_conference', fundingField: 'conference' }))).toThrow(/ndaaConference/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ track: 'authorization', stage: 'ndaa_conference', fundingField: 'ndaaConference' }))).not.toThrow();
  });

  it('NC13 HAC-D and SAC-D fields cannot be swapped', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ stage: 'hac_d', fundingField: 'sacDMark' }))).toThrow(/hacDMark/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ stage: 'sac_d', fundingField: 'hacDMark' }))).toThrow(/sacDMark/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ stage: 'sac_d', fundingField: 'sacDMark' }))).not.toThrow();
  });

  it('NC14 missing appropriations conference comparison cannot pass certification', () => {
    expect(certifyPhase6CycleV1(cycle('NOT_RUN')).status).toBe('NEEDS_REVIEW');
    expect(certifyPhase6CycleV1(cycle('PASS')).status).toBe('CERTIFIED');
  });

  it('NC15 public-law label alone cannot create enacted', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ stage: 'public_law', fundingField: 'enacted' }))).toThrow(/enactmentProofId/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ stage: 'public_law', fundingField: 'enacted', enactmentProofId: 'proof-1' }))).not.toThrow();
  });

  it('NC16 incorporated statement requires incorporation proof', () => {
    const base = {
      schemaVersion: 'defense_budget_enactment_proof_v1',
      proofId: 'proof',
      fiscalYear: FY,
      publicLawNumber: 'P.L. 119-99',
      enactmentDate: '2027-09-30',
      billId: 'H.R. 5001',
      vehicleKind: 'full_year',
      publicLawSource: { manifestDocumentKey: 'pl', sourceDocumentId: 'pl', sourceSha256: SHA, status: 'current' },
      lineDetailSource: { manifestDocumentKey: 'jes', sourceDocumentId: 'jes', sourceSha256: 'b'.repeat(64), status: 'current' },
      proofType: 'incorporated_explanatory_statement',
      vehicleProfileHash: SHA,
      reviewerStatus: 'verified',
      explicitLineAuthority: false,
    };
    expect(() => defenseBudgetEnactmentProofV1Schema.parse(base)).toThrow(/incorporation/);
    expect(() => defenseBudgetEnactmentProofV1Schema.parse({ ...base, incorporationEvidence: { citation: 'Sec. 4', sourceDocumentId: 'pl', sourceSha256: SHA, evidenceIds: ['pl-e1'] } })).not.toThrow();
  });

  it('NC17 continuing resolution cannot masquerade as full-year enacted', () => {
    const base = { stage: 'continuing_resolution', fundingField: 'enacted', enactmentProofId: 'proof-cr', payload: {} };
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw(base))).toThrow(/explicit line authority/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ ...base, payload: { explicitLineAuthority: true } }))).not.toThrow();
  });

  it('NC18 rescission sign cannot be reversed', () => {
    expect(() => action({ actionType: 'rescission', signedValueMillions: '5', direction: 'decrease' })).toThrow(/non-positive/);
    expect(() => action({ actionType: 'rescission', signedValueMillions: '-5', direction: 'decrease' })).not.toThrow();
  });

  it('NC19 transfer direction cannot be lost through silent netting', () => {
    const outgoing = action({
      actionId: 't-out',
      actionType: 'transfer_out',
      identity: undefined,
      sourceIdentity: PE,
      destinationIdentity: PE2,
      transferGroupId: 't1',
      amount: money('3'),
      signedValueMillions: '-3',
      direction: 'out',
    });
    expect(verifyAppropriationsActionsV1({ actions: [outgoing] }).status).toBe('BLOCKED');
    const incoming = action({
      actionId: 't-in',
      actionType: 'transfer_in',
      identity: undefined,
      sourceIdentity: PE,
      destinationIdentity: PE2,
      transferGroupId: 't1',
      amount: money('3'),
      signedValueMillions: '3',
      direction: 'in',
    });
    const verified = verifyAppropriationsActionsV1({ actions: [outgoing, incoming] });
    expect(verified.status).toBe('PASS');
    expect(buildVerifiedStageActionProjectionPlanV1(verified).candidates).toHaveLength(2);
  });

  it('NC20 transfer amount cannot become a revised reprogrammed total', () => {
    const base = {
      schemaVersion: 'defense_budget_reprogramming_event_v1',
      eventId: 'r1',
      controlNumber: 'DD-27-1',
      status: 'approved',
      date: '2027-11-01',
      fiscalYear: FY,
      sourceDocumentId: 'r-doc',
      sourceSha256: SHA,
      sourceIdentity: PE,
      destinationIdentity: PE2,
      amount: money('3'),
      evidenceIds: ['e1'],
      policyAllowsDerivedRevisedTotal: false,
    };
    const actionOnly = composeReprogrammingEventV1(base);
    expect(actionOnly.actions).toHaveLength(2);
    expect(actionOnly.revisedPositions).toHaveLength(0);
    const explicit = composeReprogrammingEventV1({
      ...base,
      sourceAfter: money('97'),
      destinationAfter: money('103'),
    });
    expect(explicit.revisedPositions).toHaveLength(2);
  });

  it('NC21 obligations and outlays cannot be conflated', () => {
    const profile = {
      schemaVersion: 'execution_source_profile_v1',
      profileId: 'execution',
      fiscalYear: FY,
      metric: 'obligations',
      sourceSystem: 'DFAS',
      sourceDocumentId: 'execution-doc',
      sourceSha256: SHA,
      mapsToExecutedField: true,
    };
    const record = {
      schemaVersion: 'execution_record_v1',
      recordId: 'e1',
      identity: PE,
      metric: 'outlays',
      asOfDate: '2027-12-31',
      budgetFiscalYear: FY,
      amount: money('50'),
      sourceSystem: 'DFAS',
      sourceDocumentId: 'execution-doc',
      sourceSha256: SHA,
      evidenceIds: ['ev'],
      cumulative: true,
    };
    expect(() => composeExecutionRecordV1(profile, record)).toThrow(/ambiguous execution metric/);
    expect(() => composeExecutionRecordV1(profile, { ...record, metric: 'obligations' })).not.toThrow();
  });

  it('NC22 stale or superseded vehicle proof cannot be accepted', () => {
    const base = {
      schemaVersion: 'appropriations_conference_vehicle_proof_v1',
      track: 'appropriations',
      stage: 'appropriations_conference',
      authority: 'appropriations_conference',
      fiscalYear: FY,
      billId: 'H.R. 5001',
      vehicleStructure: 'standalone',
      primary: { manifestDocumentKey: 'conf', sourceDocumentId: 'conf-doc', sourceSha256: SHA, vehicleClass: 'conference_report', current: false },
    };
    expect(() => appropriationsConferenceVehicleProofV1Schema.parse(base)).toThrow();
    expect(() => appropriationsConferenceVehicleProofV1Schema.parse({ ...base, primary: { ...base.primary, current: true } })).not.toThrow();
  });

  it('NC23 candidate line binding cannot machine-pass', () => {
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ bindingStatus: 'candidate' }))).toThrow(/accepted native binding/);
    expect(() => phase6NativeProjectionV1Schema.parse(projectionRaw({ bindingStatus: 'accepted' }))).not.toThrow();
  });

  it('NC24 canonical writer import is permanently prohibited', () => {
    expect(scanPhase6ArchitectureSourceV1("import { ProgramElementWriterService } from '../program-element/program-element-writer.service.js';").map((item) => item.code)).toContain('legacy_writer_import');
    expect(scanPhase6ArchitectureSourceV1('export const projectionOnly = true;')).toEqual([]);
  });
});
