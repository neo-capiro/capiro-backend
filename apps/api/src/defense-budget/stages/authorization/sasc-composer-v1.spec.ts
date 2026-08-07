import type {
  BudgetLineIdentityV1,
  DefenseBudgetAssertionV1,
  ExtractionSourceV1,
  ParserRunV1,
} from '../../contracts/extraction-artifact-v1.js';
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
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
import { composeSascStageV1 } from './sasc-composer-v1.js';
import { createHascSourceProfileV1 } from './hasc-source-profile-v1.js';
import { createSascSourceProfileV1 } from './sasc-source-profile-v1.js';

const FY = 2027;
const SHA = 'a'.repeat(64);
const SOURCE_DOCUMENT_ID = 'source-sasc-fy2027';
const PROFILE = createSascSourceProfileV1({
  fiscalYear: FY,
  reportNumber: 'S. Rept. 119-39',
  sourceDocumentKeys: ['sasc_fy2027'],
});
const SOURCE: ExtractionSourceV1 = {
  manifestDocumentKey: 'sasc_fy2027',
  sourceDocumentId: SOURCE_DOCUMENT_ID,
  sourcePdfSha256: SHA,
  sourceLocator: 's3://test/sasc-fy2027.pdf',
  fiscalYear: FY,
  family: 'committee',
  exhibit: 'committee_report',
  authority: 'sasc',
  component: 'DW',
  budgetCycle: 'fy2027',
  documentType: 'committee_report',
};
const RUN: ParserRunV1 = {
  parserRunId: 'sasc-parser-run',
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
  return {
    headerText: `column-${overrides.columnIndex}`,
    isQuantity: false,
    ...overrides,
  } as CongressionalColumnV1;
}

function row(
  overrides: Partial<CongressionalRowV1> & Pick<CongressionalRowV1, 'rowIndex' | 'reference'>,
): CongressionalRowV1 {
  return {
    rawLabel: 'row',
    semanticKind: 'absolute_position',
    cells: [],
    ...overrides,
  } as CongressionalRowV1;
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
    page: 213,
    printedPage: 'S. Rept. 119-39, p. 213',
    headings: ['TITLE II — RESEARCH, DEVELOPMENT, TEST AND EVALUATION'],
    declaredUnit: 'thousands',
    columns: [
      column({ columnIndex: 0, headerText: 'Line' }),
      column({
        columnIndex: 1,
        headerText: 'FY 2027 Budget Estimate',
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
        headerText: 'Senate Recommendation',
        moneySemantic: 'recommended_total',
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
  return composeSascStageV1({
    profile: PROFILE,
    source: SOURCE,
    parserRuns: [RUN],
    tables,
    resolutionContext: {
      index,
      fiscalYear: FY,
      profileId: PROFILE.profileId,
    },
  });
}

function fundingAssertions(result: ReturnType<typeof compose>) {
  return result.artifact.assertions.filter(
    (assertion): assertion is Extract<DefenseBudgetAssertionV1, { assertionKind: 'funding' }> =>
      assertion.assertionKind === 'funding',
  );
}

describe('SASC composer V1', () => {
  it('emits sascMark for all four supported native line kinds', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(
          1,
          {
            referenceKind: 'procurement_line',
            lineCode: 'W12002',
            account: '2035A',
            component: 'ARMY',
          },
          '80',
          '-5',
          '75',
        ),
        positionRow(
          2,
          {
            referenceKind: 'om_sag',
            sagCode: '121',
            account: '2020A',
            component: 'ARMY',
          },
          '40',
          '2',
          '42',
        ),
        positionRow(
          3,
          {
            referenceKind: 'milcon_project',
            projectCode: 'PN12345',
            component: 'AF',
            location: 'Eglin AFB',
          },
          '20',
          '5',
          '25',
        ),
      ]),
    ]);

    const funding = fundingAssertions(result);
    expect(funding).toHaveLength(4);
    expect(funding.every((assertion) => assertion.field === 'sascMark')).toBe(true);
    expect(funding.some((assertion) => assertion.field === 'hascMark')).toBe(false);
    expect(funding.some((assertion) => assertion.field === 'request')).toBe(false);
    expect(result.coverage.byLineKind.RDTE_PE.positionsEmitted).toBe(1);
    expect(result.coverage.byLineKind.PROCUREMENT_BLIN.positionsEmitted).toBe(1);
    expect(result.coverage.byLineKind.OM_SAG.positionsEmitted).toBe(1);
    expect(result.coverage.byLineKind.MILCON_PROJECT.positionsEmitted).toBe(1);
  });

  it('preserves Senate printed-page evidence and normalized footnoted amounts', () => {
    const result = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'pe_code', peCode: '0605053A' },
          '100000',
          '25000',
          '125000',
          '125,000†',
        ),
      ]),
    ]);
    const funding = fundingAssertions(result)[0]!;
    expect(funding.money.originalValue).toBe('125000');
    expect(funding.metadata?.printedPage).toBe('S. Rept. 119-39, p. 213');
    expect(result.artifact.evidence.some((item) => item.excerpt === '125,000†')).toBe(true);
  });

  it('retains a cross-page continuation finding on the continuation page', () => {
    const continued = positionRow(
      0,
      { referenceKind: 'pe_code', peCode: '0605053A' },
      '100',
      '25',
      '125',
    );
    continued.finding = 'continued from physical page 212';
    const result = compose([
      table([continued], {
        page: 213,
        printedPage: 'S. Rept. 119-39, p. 213',
      }),
    ]);
    expect(new Set(result.artifact.evidence.map((item) => item.page))).toEqual(new Set([212, 213]));
    const action = result.artifact.assertions.find(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    expect(action).toBeDefined();
  });

  it('composes agreeing duplicate Senate rows once and retains all evidence', () => {
    const first = positionRow(
      0,
      { referenceKind: 'pe_code', peCode: '0605053A' },
      '100',
      '25',
      '125',
    );
    const second = positionRow(
      1,
      { referenceKind: 'pe_code', peCode: '0605053A' },
      '100',
      '25',
      '125',
    );
    const result = compose([table([first, second])]);
    expect(fundingAssertions(result)).toHaveLength(1);
    expect(fundingAssertions(result)[0]!.evidenceIds.length).toBeGreaterThan(4);
  });

  it('blocks conflicting repeated Senate rows instead of selecting a winner', () => {
    const result = compose([
      table([
        positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125'),
        positionRow(1, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '30', '130'),
      ]),
    ]);
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('blocked');
    expect(result.artifact.omissions).toHaveLength(2);
  });

  it('keeps title-only candidates out of machine-pass funding', () => {
    const result = compose(
      [
        table([
          positionRow(
            0,
            {
              referenceKind: 'procurement_line',
              lineCode: 'UNKNOWN',
              rowTitle: 'Ground Robotics',
            },
            '100',
            '25',
            '125',
          ),
        ]),
      ],
      INDEX,
    );
    expect(fundingAssertions(result)).toHaveLength(0);
    expect(result.coverage.status).toBe('complete_with_review');
    expect(result.coverage.totals.candidateBindings).toBe(1);
    expect(result.unresolved.schemaVersion).toBe('sasc_unresolved_report_v1');
    expect(result.unresolved.entries).toHaveLength(1);
    expect(result.unresolved.entries[0]).toMatchObject({
      status: 'candidate',
      lineKind: 'PROCUREMENT_BLIN',
      page: 213,
    });
  });

  it('reports unresolved Senate identities independently from coverage', () => {
    const result = compose([
      table([
        positionRow(
          0,
          { referenceKind: 'procurement_line', lineCode: 'W12002' },
          '100',
          '25',
          '125',
        ),
      ]),
    ]);
    expect(result.coverage.status).toBe('blocked');
    expect(result.unresolved.entries).toEqual([
      expect.objectContaining({
        page: 213,
        rowIndex: 0,
        lineKind: 'PROCUREMENT_BLIN',
        status: 'unresolved',
        candidateIdentityKeys: [],
      }),
    ]);
  });

  it('emits package-wide Senate actions without attributing them to one line', () => {
    const packageRow = row({
      rowIndex: 0,
      reference: { referenceKind: 'package_scope', scope: 'TITLE II' },
      rawLabel: 'Undistributed reduction',
      semanticKind: 'undistributed',
      cells: [
        { rowIndex: 0, columnIndex: 0, rawText: 'Undistributed reduction' },
        { rowIndex: 0, columnIndex: 2, rawText: '(5,000)', value: '-5000' },
      ],
    });
    const result = compose([table([packageRow])]);
    const action = result.artifact.assertions.find(
      (assertion) =>
        assertion.assertionKind === 'document_fact' &&
        assertion.fieldName === DEFENSE_BUDGET_STAGE_ACTION_FIELD,
    );
    expect(action).toBeDefined();
    if (action?.assertionKind !== 'document_fact') throw new Error('expected action');
    const parsed = parseCommitteeStageActionV1(action.value);
    expect(parsed.packageScope).toBe('TITLE II');
    expect(parsed.identity).toBeUndefined();
  });

  it('rejects a HASC profile rather than emitting a HASC field', () => {
    const hascProfile = createHascSourceProfileV1({
      fiscalYear: FY,
      reportNumber: 'H. Rept. 119-000',
      sourceDocumentKeys: ['hasc_fy2027'],
    });
    expect(() =>
      composeSascStageV1({
        profile: hascProfile,
        source: SOURCE,
        parserRuns: [RUN],
        tables: [],
        resolutionContext: {
          index: INDEX,
          fiscalYear: FY,
          profileId: hascProfile.profileId,
        },
      }),
    ).toThrow('SASC composer requires stage=sasc');
  });

  it('replays deterministically', () => {
    const input = [
      table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')]),
    ];
    expect(compose(input)).toEqual(compose(input));
  });

  it('never emits request funding when it emits a non-owning baseline fact', () => {
    const result = compose([
      table([positionRow(0, { referenceKind: 'pe_code', peCode: '0605053A' }, '100', '25', '125')]),
    ]);
    expect(
      result.artifact.assertions.some(
        (assertion) => assertion.assertionKind === 'funding' && assertion.field === 'request',
      ),
    ).toBe(false);
    expect(
      result.artifact.assertions.some(
        (assertion) =>
          assertion.assertionKind === 'document_fact' &&
          assertion.fieldName === COMMITTEE_REQUEST_BASELINE_FIELD,
      ),
    ).toBe(true);
  });
});
