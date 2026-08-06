import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../../contracts/extraction-artifact-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  type CongressionalColumnV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from '../../congressional-table-v1.js';
import type { NativeIdentityIndexEntry } from '../../line-reference-resolver.js';
import {
  COMMITTEE_REQUEST_BASELINE_FIELD,
  DEFENSE_BUDGET_STAGE_ACTION_FIELD,
  parseCommitteeStageActionV1,
} from '../../authorization/committee-stage-facts-v1.js';
import { composeHacdStageV1 } from './hacd-composer-v1.js';
import { createHacdSourceProfileV1 } from './hacd-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const SOURCE_DOCUMENT_ID = 'source-hacd-fy2027';
const PROFILE = createHacdSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'H. Rept. 119-715',
  sourceDocumentKeys: ['hacd_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'hacd_fy2027',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/hacd-fy2027.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'hac_d',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'hacd-parser-run',
  method: 'deterministic_pdfplumber',
  parserVersion: 'pdfplumber-0.11.0',
  parserConfigSha256: 'b'.repeat(64),
  inputSourceSha256: SHA,
  outputArtifactSha256: 'c'.repeat(64),
  pageRanges: [{ startPage: 1, endPage: 500 }],
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

function column(
  overrides: Partial<CongressionalColumnV1> & { columnIndex: number },
): CongressionalColumnV1 {
  return { headerText: `column-${overrides.columnIndex}`, isQuantity: false, ...overrides } as CongressionalColumnV1;
}

function row(
  overrides: Partial<CongressionalRowV1> & Pick<CongressionalRowV1, 'rowIndex' | 'reference'>,
): CongressionalRowV1 {
  return { rawLabel: 'row', semanticKind: 'absolute_position', cells: [], ...overrides } as CongressionalRowV1;
}

function table(
  rows: CongressionalRowV1[],
  overrides: Partial<CongressionalTableV1> = {},
): CongressionalTableV1 {
  return {
    schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
    profileId: PROFILE.profileId,
    sourceDocumentId: SOURCE_DOCUMENT_ID,
    sourceSha256: SHA,
    page: 75,
    printedPage: 'H. Rept. 119-715, p. 75',
    headings: ['TITLE IV — RESEARCH, DEVELOPMENT, TEST AND EVALUATION'],
    declaredUnit: 'thousands',
    columns: [
      column({ columnIndex: 0, headerText: 'Line' }),
      column({
        columnIndex: 1,
        headerText: 'FY 2027 Budget Request',
        moneySemantic: 'request_baseline',
        fiscalYear: FY,
      }),
      column({
        columnIndex: 2,
        headerText: 'Change',
        moneySemantic: 'change',
        fiscalYear: FY,
      }),
      column({
        columnIndex: 3,
        headerText: 'Committee Recommendation',
        moneySemantic: 'appropriated_total',
        fiscalYear: FY,
      }),
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
  return composeHacdStageV1({
    profile: PROFILE,
    source: SOURCE,
    parserRuns: [RUN],
    tables,
    resolutionContext: { index, fiscalYear: FY, profileId: PROFILE.profileId },
  });
}

function fundingAssertions(result: ReturnType<typeof compose>) {
  return result.artifact.assertions.filter(
    (assertion): assertion is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
      assertion.assertionKind === 'funding',
  );
}

describe('HAC-D composer V1', () => {
  it('emits hacDMark for all four native line kinds and no authorization field', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(
          1,
          { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' },
          '80',
          '-5',
          '75',
        ),
        positionRow(
          2,
          { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' },
          '40',
          '2',
          '42',
        ),
        positionRow(
          3,
          { referenceKind: 'milcon_project', projectCode: 'PN12345', component: 'AF', location: 'Eglin AFB' },
          '20',
          '5',
          '25',
        ),
      ]),
    ]);
    const funding = fundingAssertions(result);
    expect(funding).toHaveLength(4);
    expect(funding.every((assertion) => assertion.field === 'hacDMark')).toBe(true);
    expect(funding.some((assertion) => ['hascMark', 'sascMark'].includes(assertion.field))).toBe(false);
    expect(result.coverage.byLineFamily.RDTE_PE.positionsEmitted).toBe(1);
    expect(result.coverage.byLineFamily.PROCUREMENT_BLIN.positionsEmitted).toBe(1);
    expect(result.coverage.byLineFamily.OM_SAG.positionsEmitted).toBe(1);
    expect(result.coverage.byLineFamily.MILCON_PROJECT.positionsEmitted).toBe(1);
  });

  it('preserves request as a non-owning comparison fact and typed action', () => {
    const result = compose([
      table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')]),
    ]);
    expect(fundingAssertions(result).some((assertion) => assertion.field === 'request')).toBe(false);
    expect(
      result.artifact.assertions.some(
        (assertion) =>
          assertion.assertionKind === 'document_fact' &&
          assertion.fieldName === COMMITTEE_REQUEST_BASELINE_FIELD,
      ),
    ).toBe(true);
    const action = result.artifact.assertions.find(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    expect(action).toBeDefined();
    if (action?.assertionKind !== 'document_fact') throw new Error('expected action');
    expect(parseCommitteeStageActionV1(action.value).track).toBe('appropriations');
  });

  it('keeps classified and general-transfer rows as package actions, never line totals', () => {
    const rows = [
      row({
        rowIndex: 0,
        reference: { referenceKind: 'package_scope', scope: 'HAC-D classified programs' },
        rawLabel: 'Classified adjustment — undistributed',
        semanticKind: 'undistributed',
        cells: [{ rowIndex: 0, columnIndex: 2, rawText: '-10', value: '-10' }],
      }),
      row({
        rowIndex: 1,
        reference: { referenceKind: 'package_scope', scope: 'HAC-D general transfer authority' },
        rawLabel: 'Transfer out — general transfer authority',
        semanticKind: 'transfer_out',
        cells: [{ rowIndex: 1, columnIndex: 2, rawText: '-5', value: '-5' }],
      }),
      row({
        rowIndex: 2,
        reference: { referenceKind: 'package_scope', scope: 'HAC-D report package' },
        rawLabel: 'General provision — transfer reserve',
        semanticKind: 'general_provision',
        cells: [{ rowIndex: 2, columnIndex: 2, rawText: '2', value: '2' }],
      }),
    ];
    const result = compose([table(rows, { headings: ['CLASSIFIED PROGRAMS — GENERAL TRANSFER'] })]);
    expect(fundingAssertions(result)).toHaveLength(0);
    const actions = result.artifact.assertions.filter(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    expect(actions).toHaveLength(3);
    expect(result.coverage.byLineFamily.CLASSIFIED.actionsEmitted).toBeGreaterThan(0);
  });

  it('reports procurement and O&M account coverage independently', () => {
    const result = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' },
          '80',
          '-5',
          '75',
        ),
        positionRow(
          1,
          { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' },
          '40',
          '2',
          '42',
        ),
      ]),
    ]);
    expect(result.coverage.byAccount['2035A']).toMatchObject({ representedRows: 1, positionsEmitted: 1 });
    expect(result.coverage.byAccount['2020A']).toMatchObject({ representedRows: 1, positionsEmitted: 1 });
  });

  it('blocks conflicting duplicate HAC-D rows instead of choosing a winner', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(1, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '30', '130'),
      ]),
    ]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('blocked');
  });

  it('keeps a title-only identity candidate out of machine-pass funding', () => {
    const result = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'procurement_line', lineCode: 'UNKNOWN', rowTitle: 'Ground Robotics' },
          '100',
          '25',
          '125',
        ),
      ]),
    ]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('complete_with_review');
    expect(result.unresolved.entries[0]).toMatchObject({ status: 'candidate', lineFamily: 'PROCUREMENT_BLIN' });
  });

  it('replays deterministically', () => {
    const input = [
      table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')]),
    ];
    expect(compose(input)).toEqual(compose(input));
  });
});
