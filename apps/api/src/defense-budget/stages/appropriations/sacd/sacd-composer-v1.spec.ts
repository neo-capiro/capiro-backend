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
import { createHacdSourceProfileV1 } from '../hacd/hacd-source-profile-v1.js';
import { composeSacdStageV1 } from './sacd-composer-v1.js';
import { createSacdSourceProfileV1 } from './sacd-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const SOURCE_DOCUMENT_ID = 'source-sacd-fy2027';
const PROFILE = createSacdSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'S. Rept. 119-200',
  sourceDocumentKeys: ['sacd_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'sacd_fy2027',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/sacd-fy2027.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'sac_d',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'sacd-parser-run',
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
    page: 180,
    printedPage: 'S. Rept. 119-200, p. 180',
    headings: ['TITLE IV — RESEARCH, DEVELOPMENT, TEST AND EVALUATION'],
    declaredUnit: 'thousands',
    columns: [
      column({ columnIndex: 0, headerText: 'Line' }),
      column({ columnIndex: 1, headerText: 'FY 2027 Budget Estimate', moneySemantic: 'request_baseline', fiscalYear: FY }),
      column({ columnIndex: 2, headerText: 'Change', moneySemantic: 'change', fiscalYear: FY }),
      column({ columnIndex: 3, headerText: 'Senate Recommendation', moneySemantic: 'appropriated_total', fiscalYear: FY }),
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
  rawMark = mark,
): CongressionalRowV1 {
  return row({
    rowIndex,
    reference,
    rawLabel: JSON.stringify(reference),
    cells: [
      { rowIndex, columnIndex: 0, rawText: 'identity' },
      { rowIndex, columnIndex: 1, rawText: request, value: request },
      { rowIndex, columnIndex: 2, rawText: change, value: change },
      { rowIndex, columnIndex: 3, rawText: rawMark, value: mark },
    ],
  });
}

function compose(tables: CongressionalTableV1[], index = INDEX) {
  return composeSacdStageV1({
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

describe('SAC-D composer V1', () => {
  it('emits sacDMark for all four native line kinds and no HAC-D/authorization field', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(1, { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' }, '80', '-5', '75'),
        positionRow(2, { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' }, '40', '2', '42'),
        positionRow(3, { referenceKind: 'milcon_project', projectCode: 'PN12345', component: 'AF', location: 'Eglin AFB' }, '20', '5', '25'),
      ]),
    ]);
    const funding = fundingAssertions(result);
    expect(funding).toHaveLength(4);
    expect(funding.every((assertion) => assertion.field === 'sacDMark')).toBe(true);
    expect(funding.some((assertion) => ['hacDMark', 'hascMark', 'sascMark'].includes(assertion.field))).toBe(false);
    expect(result.coverage.byLineFamily.PROCUREMENT_BLIN.positionsEmitted).toBe(1);
    expect(result.coverage.byLineFamily.OM_SAG.positionsEmitted).toBe(1);
  });

  it('preserves request as non-owning comparison data and emits a typed appropriations action', () => {
    const result = compose([table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')])]);
    expect(fundingAssertions(result).some((assertion) => assertion.field === 'request')).toBe(false);
    expect(result.artifact.assertions.some((assertion) => assertion.assertionKind === 'document_fact' && assertion.fieldName === COMMITTEE_REQUEST_BASELINE_FIELD)).toBe(true);
    const action = result.artifact.assertions.find((assertion) => assertion.assertionKind === 'document_fact' && assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD);
    if (action?.assertionKind !== 'document_fact') throw new Error('expected action');
    expect(parseCommitteeStageActionV1(action.value)).toMatchObject({ track: 'appropriations', stage: 'sac_d', authority: 'sacd_appropriations' });
  });

  it('preserves Senate footnote text and cross-page continuation evidence', () => {
    const continued = positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100000', '25000', '125000', '125,000†');
    continued.finding = 'continued from physical page 179';
    const result = compose([table([continued], { page: 180 })]);
    expect(fundingAssertions(result)[0]!.money.originalValue).toBe('125000');
    expect(new Set(result.artifact.evidence.map((item) => item.page))).toEqual(new Set([179, 180]));
    expect(result.artifact.evidence.some((item) => item.excerpt === '125,000†')).toBe(true);
  });

  it('reports split-account native coverage independently', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'procurement_line', lineCode: 'W12002', account: '2035A', component: 'ARMY' }, '80', '-5', '75'),
        positionRow(1, { referenceKind: 'om_sag', sagCode: '121', account: '2020A', component: 'ARMY' }, '40', '2', '42'),
      ]),
    ]);
    expect(result.coverage.byAccount['2035A']).toMatchObject({ representedRows: 1, positionsEmitted: 1 });
    expect(result.coverage.byAccount['2020A']).toMatchObject({ representedRows: 1, positionsEmitted: 1 });
  });

  it('blocks conflicting duplicate Senate rows', () => {
    const result = compose([table([
      positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
      positionRow(1, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '30', '130'),
    ])]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('blocked');
  });

  it('keeps title-only candidates out of machine-pass funding', () => {
    const result = compose([table([
      positionRow(0, { referenceKind: 'procurement_line', lineCode: 'UNKNOWN', rowTitle: 'Ground Robotics' }, '100', '25', '125'),
    ])]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('complete_with_review');
    expect(result.unresolved.entries[0]).toMatchObject({ status: 'candidate', lineFamily: 'PROCUREMENT_BLIN' });
  });

  it('emits classified/general-transfer rows only as package actions', () => {
    const result = compose([table([
      row({ rowIndex: 0, reference: { referenceKind: 'package_scope', scope: 'SAC-D classified programs' }, rawLabel: 'Classified adjustment — undistributed', semanticKind: 'undistributed', cells: [{ rowIndex: 0, columnIndex: 2, rawText: '-10', value: '-10' }] }),
      row({ rowIndex: 1, reference: { referenceKind: 'package_scope', scope: 'SAC-D general transfer authority' }, rawLabel: 'Transfer out — general transfer authority', semanticKind: 'transfer_out', cells: [{ rowIndex: 1, columnIndex: 2, rawText: '-5', value: '-5' }] }),
    ], { headings: ['CLASSIFIED PROGRAMS — GENERAL TRANSFER'] })]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.artifact.assertions.filter((assertion) => assertion.assertionKind === 'document_fact' && assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD)).toHaveLength(2);
  });

  it('rejects HAC-D/SAC-D profile swapping', () => {
    const hacd = createHacdSourceProfileV1({ fiscalYear: FY, reportNumber: 'H. Rept. 119-715', sourceDocumentKeys: ['hacd_fy2027'] });
    expect(() => composeSacdStageV1({
      profile: hacd,
      source: SOURCE,
      parserRuns: [RUN],
      tables: [],
      resolutionContext: { index: INDEX, fiscalYear: FY, profileId: hacd.profileId },
    })).toThrow('SAC-D composer requires stage=sac_d');
  });

  it('replays deterministically', () => {
    const input = [table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')])];
    expect(compose(input)).toEqual(compose(input));
  });
});
