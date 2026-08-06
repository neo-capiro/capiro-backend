import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  congressionalTableV1Schema,
  type CongressionalColumnV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from '../congressional-table-v1.js';
import type { NativeIdentityIndexEntry } from '../line-reference-resolver.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  parseCommitteeStageActionV1,
} from './committee-stage-facts-v1.js';
import { composeHascStageV1 } from './hasc-composer-v1.js';
import { createHascSourceProfileV1 } from './hasc-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const SOURCE_DOCUMENT_ID = 'source-hasc-fy2027';
const PROFILE = createHascSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'H. Rept. 119-000',
  sourceDocumentKeys: ['hasc_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'hasc_fy2027',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/hasc-fy2027.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'hasc',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'hasc-parser-run',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 20 }],
};

const PE: BudgetLineIdentityV1 = { lineKind: 'RDTE_PE', peCode: '0605053A' };
const PROCUREMENT: BudgetLineIdentityV1 = {
  lineKind: 'PROCUREMENT_BLIN',
  code: 'W12002',
  account: '2035A',
  component: 'ARMY',
};
const OM: BudgetLineIdentityV1 = {
  lineKind: 'OM_SAG',
  code: '121',
  account: '2020A',
  component: 'ARMY',
};
const MILCON: BudgetLineIdentityV1 = {
  lineKind: 'MILCON_PROJECT',
  projectCode: 'PN12345',
  component: 'AF',
  location: 'Eglin AFB',
};
const INDEX: NativeIdentityIndexEntry[] = [
  { identity: PE, manifestDocumentKey: 'r1', title: 'Ground Robotics' },
  { identity: PROCUREMENT, manifestDocumentKey: 'p1', title: 'Robotics and Applique Systems' },
  { identity: OM, manifestDocumentKey: 'o1', title: 'Operating Forces' },
  { identity: MILCON, manifestDocumentKey: 'c1', title: 'Advanced Test Facility' },
];

function column(overrides: Partial<CongressionalColumnV1> & { columnIndex: number }): CongressionalColumnV1 {
  return { headerText: `column-${overrides.columnIndex}`, isQuantity: false, ...overrides } as CongressionalColumnV1;
}
function row(overrides: Partial<CongressionalRowV1> & Pick<CongressionalRowV1, 'rowIndex' | 'reference'>): CongressionalRowV1 {
  return {
    rawLabel: 'row',
    semanticKind: 'absolute_position',
    cells: [],
    ...overrides,
  } as CongressionalRowV1;
}
function table(rows: CongressionalRowV1[], overrides: Partial<CongressionalTableV1> = {}): CongressionalTableV1 {
  return {
    schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
    profileId: PROFILE.profileId,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceSha256: SHA,
    page: 1,
    headings: ['TITLE II — RESEARCH, DEVELOPMENT, TEST AND EVALUATION'],
    declaredUnit: 'thousands',
    columns: [
      column({ columnIndex: 0, headerText: 'Line' }),
      column({ columnIndex: 1, headerText: 'FY 2027 Request', moneySemantic: 'request_baseline', fiscalYear: FY }),
      column({ columnIndex: 2, headerText: 'Change', moneySemantic: 'change', fiscalYear: FY }),
      column({ columnIndex: 3, headerText: 'Committee Recommendation', moneySemantic: 'recommended_total', fiscalYear: FY }),
    ],
    rows,
    ...overrides,
  };
}
function positionRow(
  rowIndex: number,
  reference: CongressionalRowV1['reference'],
  request: string,
  change: string,
  mark: string,
): CongressionalRowV1 {
  return row({
    rowIndex,
    reference,
    rawLabel: JSON.stringify(reference),
    cells: [
      { rowIndex, columnIndex: 0, rawText: 'identity' },
      { rowIndex, columnIndex: 1, rawText: request, value: request },
      { rowIndex, columnIndex: 2, rawText: change, value: change },
      { rowIndex, columnIndex: 3, rawText: mark, value: mark },
    ],
  });
}
function compose(tables: CongressionalTableV1[], index = INDEX) {
  return composeHascStageV1({
    profile: PROFILE,
    source: SOURCE,
    parserRuns: [RUN],
    tables,
    resolutionContext: { index, fiscalYear: FY, profileId: PROFILE.profileId },
  });
}

describe('HASC composer V1', () => {
  it('emits HASC marks for all four supported native line kinds', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(1, { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' }, '80', '-5', '75'),
        positionRow(2, { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' }, '40', '2', '42'),
        positionRow(3, { referenceKind: 'milcon_project', projectCode: 'PN12345', component: 'AF', location: 'Eglin AFB' }, '20', '5', '25'),
      ]),
    ]);
    const funding = result.artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'funding' }
      > => assertion.assertionKind === 'funding',
    );
    expect(funding).toHaveLength(4);
    expect(funding.every((a) => a.field === 'hascMark')).toBe(true);
    expect(new Set(funding.map((a) => a.identity.lineKind))).toEqual(
      new Set(['RDTE_PE', 'PROCUREMENT_BLIN', 'OM_SAG', 'MILCON_PROJECT']),
    );
    expect(result.coverage.totals.positionsEmitted).toBe(4);
    expect(result.coverage.status).toBe('complete');
  });

  it('preserves printed request values only as non-owning document facts', () => {
    const result = compose([table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')])]);
    expect(
      result.artifact.assertions.some((a) => a.assertionKind === 'funding' && a.field === 'request'),
    ).toBe(false);
    const baselines = result.artifact.assertions.filter(
      (a) => a.assertionKind === 'document_fact' && a.fieldName === COMMITTEE_REQUEST_BASELINE_FIELD,
    );
    expect(baselines).toHaveLength(1);
  });

  it('keeps adjustment-only rows as typed actions and never invents a HASC total', () => {
    const adjustment = row({
      rowIndex: 0,
      reference: { referenceKind: 'pe_code', peCode: '0605053A' },
      rawLabel: 'Program increase — Ground Robotics autonomy testing',
      semanticKind: 'adjustment',
      cells: [{ rowIndex: 0, columnIndex: 2, rawText: '15', value: '15' }],
      finding: 'increase for autonomy testing',
    });
    const result = compose([table([adjustment])]);
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    const actionAssertion = result.artifact.assertions.find(
      (a) => a.assertionKind === 'document_fact' && a.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    expect(actionAssertion).toBeDefined();
    if (actionAssertion?.assertionKind !== 'document_fact') throw new Error('expected action');
    const action = parseCommitteeStageActionV1(actionAssertion.value);
    expect(action.actionType).toBe('increase');
    expect(action.signedValueMillions).toBe('0.015');
  });

  it('emits package-scoped undistributed actions without attributing them to one line', () => {
    const undistributed = row({
      rowIndex: 0,
      reference: { referenceKind: 'package_scope', scope: 'TITLE II — RDT&E' },
      rawLabel: 'Undistributed reduction',
      semanticKind: 'undistributed',
      cells: [{ rowIndex: 0, columnIndex: 2, rawText: '(10)', value: '-10' }],
    });
    const result = compose([table([undistributed])]);
    const assertion = result.artifact.assertions.find(
      (a) => a.assertionKind === 'document_fact' && a.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    if (assertion?.assertionKind !== 'document_fact') throw new Error('expected action');
    const action = parseCommitteeStageActionV1(assertion.value);
    expect(action.packageScope).toBe('TITLE II — RDT&E');
    expect(action.identity).toBeUndefined();
    expect(action.actionType).toBe('undistributed_adjustment');
    expect(result.coverage.status).toBe('complete');
    expect(result.coverage.byLineKind.PACKAGE_SCOPE.unresolvedBindings).toBe(0);
  });

  it('accepts repeated headers across pages because normalized tables contain data rows only', () => {
    const first = table([
      positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
    ]);
    const second = table([
      positionRow(0, { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' }, '40', '2', '42'),
    ], { page: 2, printedPage: '77' });
    const result = compose([first, second]);
    expect(result.artifact.assertions.filter((a) => a.assertionKind === 'funding')).toHaveLength(2);
    expect(new Set(result.artifact.evidence.map((e) => e.page))).toEqual(new Set([1, 2]));
  });

  it('blocks an unresolved procurement line that lacks account namespace', () => {
    const result = compose([
      table([positionRow(0, { referenceKind: 'procurement_line', lineCode: 'W12002' }, '80', '-5', '75')]),
    ]);
    expect(result.bindings[0]?.status).toBe('unresolved');
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    expect(result.artifact.omissions[0]?.severity).toBe('blocking');
    expect(result.coverage.status).toBe('blocked');
  });

  it('routes title-only identity matches to review and never machine-passes them', () => {
    const result = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'unresolved_reference', rawText: 'Ground Robotics' },
          '100',
          '25',
          '125',
        ),
      ]),
    ]);
    expect(result.bindings[0]?.status).toBe('unresolved');
    expect(result.coverage.status).toBe('blocked');

    const candidateResult = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'procurement_line', lineCode: 'UNKNOWN', rowTitle: 'Robotics and Applique Systems' },
          '80',
          '-5',
          '75',
        ),
      ]),
    ]);
    expect(candidateResult.bindings[0]?.status).toBe('candidate');
    expect(candidateResult.artifact.omissions[0]?.severity).toBe('review');
    expect(candidateResult.coverage.status).toBe('complete_with_review');
  });


  it('composes agreeing duplicate rows to one mark while retaining both rows evidence', () => {
    const duplicateA = positionRow(
      0,
      { referenceKind: 'pe_code', peCode: '0605053A' },
      '100',
      '25',
      '125',
    );
    const duplicateB = positionRow(
      1,
      { referenceKind: 'pe_code', peCode: '0605053A' },
      '100',
      '25',
      '125',
    );
    const result = compose([table([duplicateA, duplicateB])]);
    const funding = result.artifact.assertions.filter(
      (assertion): assertion is Extract<
        DefenseBudgetAssertionV1,
        { assertionKind: 'funding' }
      > => assertion.assertionKind === 'funding',
    );
    expect(funding).toHaveLength(1);
    expect(funding[0]?.evidenceIds.length).toBe(8);
    expect(result.coverage.byLineKind.RDTE_PE.representedRows).toBe(2);
    expect(result.coverage.byLineKind.RDTE_PE.positionsEmitted).toBe(1);
    expect(result.coverage.status).toBe('complete');
  });

  it('blocks equal-key rows with unequal totals instead of choosing a winner', () => {
    const duplicateA = positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125');
    const duplicateB = positionRow(1, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '30', '130');
    const result = compose([table([duplicateA, duplicateB])]);
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    expect(result.artifact.omissions).toHaveLength(2);
    expect(result.coverage.status).toBe('blocked');
  });

  it('blocks money when no printed unit is declared', () => {
    const withoutUnits = table([
      positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
    ], {
      declaredUnit: undefined,
      columns: table([]).columns.map((entry) => ({ ...entry, declaredUnit: undefined })),
    });
    const result = compose([withoutUnits]);
    expect(result.artifact.assertions.some((a) => a.assertionKind === 'funding')).toBe(false);
    expect(result.artifact.omissions.some((o) => o.reason === 'unsupported_unit')).toBe(true);
  });

  it('rejects a normalized table with no physical page', () => {
    const valid = table([]);
    const { page: _page, ...withoutPage } = valid;
    expect(() => congressionalTableV1Schema.parse(withoutPage)).toThrow();
  });

  it('rejects an invalid unit rather than inferring scale from magnitude', () => {
    const valid = table([]);
    expect(() => congressionalTableV1Schema.parse({ ...valid, declaredUnit: 'billions' })).toThrow();
  });

  it('contains no canonical writer import', () => {
    const candidates = [
      path.resolve(process.cwd(), 'src/defense-budget/stages/authorization/hasc-composer-v1.ts'),
      path.resolve(
        process.cwd(),
        'apps/api/src/defense-budget/stages/authorization/hasc-composer-v1.ts',
      ),
    ];
    const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
    if (sourcePath == null) throw new Error('unable to locate hasc-composer-v1.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).not.toContain('ProgramElementWriterService');
    expect(source).not.toContain('program-element-writer');
    expect(source).not.toMatch(/prisma\.(create|update|upsert|delete)/);
  });
});
