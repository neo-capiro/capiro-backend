/**
 * Unit tests for r1-text-row-reconstructor-v1 (Phase 10B-11).
 *
 * Row-level fixtures below are literal, real physical text lines pulled
 * from the archived FY2024 R-1 PDF's actual `deterministic_pdfplumber`
 * output (source document 62e8a102-4f01-471b-9cb6-eab58cb41270, sha256
 * ed9f94b6068c8f1ce40483adfe69d644cc3f033bbcc8271537db39ca91101425) --
 * captured during the mandatory full-document profiling pass, not
 * hand-invented. Only the explicit negative-control edge cases (malformed
 * PE, missing anchor, etc.) are synthetic, and are labeled as such.
 *
 * The full real-document, real-parser acceptance run (page count, PE/
 * funding counts, 10+-row manual audit, real verifier outcome) lives in
 * `r1-text-reconstruction-e2e-acceptance.spec.ts`, not here.
 */
import {
  reconstructR1RowFromLine,
  reconstructR1TablesFromTextV1,
  resolveComponent,
  R1_RECONSTRUCTED_COLUMNS,
} from './r1-text-row-reconstructor-v1.js';
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';

function emptyPage(overrides: Partial<ParserPageResultV1> = {}): ParserPageResultV1 {
  return {
    page: 1,
    text: '',
    blocks: [],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
    ...overrides,
  } as ParserPageResultV1;
}

describe('reconstructR1RowFromLine -- real lines, K=5 (full column set present)', () => {
  it('PE 0603619A: 5 trailing numbers, all mapped positionally', () => {
    const row = reconstructR1RowFromLine(
      '54 0603619A Landmine Warfare and Barrier - Adv Dev 04 U 44,933 55,953 6,000 61,953 47,537',
    );
    expect(row).not.toBeNull();
    expect(row!.peCode).toBe('0603619A');
    expect(row!.title).toBe('Landmine Warfare and Barrier - Adv Dev');
    expect(row!.budgetActivity).toBe('04');
    expect(row!.category).toBe('U');
    expect(row!.moneyByRole).toEqual({
      fyMinus2Actual: '44,933',
      fyMinus1Enacted: '55,953',
      fyMinus1Supplemental: '6,000',
      fyMinus1TotalEnacted: '61,953',
      fyRequest: '47,537',
    });
  });
});

describe('reconstructR1RowFromLine -- real lines, K=4 (proven zero-supplemental collapse)', () => {
  it('the golden production row: PE 0601102A / Defense Research Sciences / request 296,670', () => {
    const row = reconstructR1RowFromLine(
      '1 0601102A Defense Research Sciences 01 U 358,521 391,642 391,642 296,670',
    );
    expect(row).not.toBeNull();
    expect(row!.peCode).toBe('0601102A');
    expect(row!.title).toBe('Defense Research Sciences');
    expect(row!.moneyByRole).toEqual({
      fyMinus2Actual: '358,521',
      fyMinus1Enacted: '391,642',
      fyMinus1Supplemental: '0', // derived: proven zero-supplemental collapse, never a guess
      fyMinus1TotalEnacted: '391,642',
      fyRequest: '296,670',
    });
    expect(row!.moneyOmissionReason).toBeNull();
  });

  it('title containing spaces, digits, and a dash: PE 0605052A "Indirect Fire Protection Capability Inc 2 - Block 1"', () => {
    const row = reconstructR1RowFromLine(
      '133 0605052A Indirect Fire Protection Capability Inc 2 - Block 1 05 U 175,604 131,093 131,093 196,248',
    );
    expect(row).not.toBeNull();
    expect(row!.peCode).toBe('0605052A');
    expect(row!.title).toBe('Indirect Fire Protection Capability Inc 2 - Block 1');
    expect(row!.moneyByRole?.fyRequest).toBe('196,248');
  });

  it('acronym-only title: PE 0604103A "(EWPMT)"', () => {
    const row = reconstructR1RowFromLine('74 0604103A (EWPMT) 04 U 2,260');
    // Only 1 trailing number -- ambiguous, covered by the K=1 test below;
    // this fixture is here to document the title-parsing edge case
    // separately from the funding-ambiguity edge case.
    expect(row).not.toBeNull();
    expect(row!.title).toBe('(EWPMT)');
  });
});

describe('reconstructR1RowFromLine -- real lines, genuinely ambiguous (identity yes, funding no)', () => {
  it('PE 0305251A: 3 trailing numbers where the FIRST two are unequal -- the collapse identity does NOT hold, must not guess', () => {
    const row = reconstructR1RowFromLine(
      '90 0305251A Cyberspace Operations Forces and Force Support 04 U 55,895 55,599 55,599',
    );
    expect(row).not.toBeNull();
    expect(row!.peCode).toBe('0305251A');
    // Identity is still recoverable...
    expect(row!.title).toBe('Cyberspace Operations Forces and Force Support');
    // ...but funding is NOT: this is exactly the real counter-example that
    // disproves "last token is always the request" as a safe universal
    // rule -- 3 trailing numbers is a genuinely different, unresolvable
    // shape from the proven 4-number collapse (which requires index 1==2,
    // not 0==1), and must never be treated as [enacted, total, request].
    expect(row!.moneyByRole).toBeNull();
    expect(row!.moneyOmissionReason).toMatch(/3 trailing numeric tokens/);
  });

  it('PE 0602115A: only 1 trailing number -- ambiguous, not guessed as the request', () => {
    const row = reconstructR1RowFromLine('7 0602115A Biomedical Technology 02 U 11,489');
    expect(row).not.toBeNull();
    expect(row!.peCode).toBe('0602115A');
    expect(row!.moneyByRole).toBeNull();
    expect(row!.moneyOmissionReason).toMatch(/1 trailing numeric tokens/);
  });

  it('4 trailing numbers where Enacted != Total Enacted would be a genuine mismatch (synthetic negative control -- this exact shape was not found in the real document, zero of 1,031 real 4-token rows violated it)', () => {
    const row = reconstructR1RowFromLine('1 0601999A Synthetic Mismatch Test 01 U 100,000 200,000 999,999 50,000');
    expect(row).not.toBeNull();
    expect(row!.moneyByRole).toBeNull();
    expect(row!.moneyOmissionReason).toMatch(/Enacted .* != Total Enacted/);
  });
});

describe('reconstructR1RowFromLine -- negative controls', () => {
  it('malformed PE code (6 digits, not 7) -> no row at all, not even an identity', () => {
    const row = reconstructR1RowFromLine('1 060110A Some Program 01 U 1,000 1,000 1,000 500');
    expect(row).toBeNull();
  });

  it('malformed PE code (no trailing letter) -> no row at all', () => {
    const row = reconstructR1RowFromLine('1 0601102 Some Program 01 U 1,000 1,000 1,000 500');
    expect(row).toBeNull();
  });

  it('subtotal/total line (no PE code present) is never mistaken for a PE row', () => {
    const row = reconstructR1RowFromLine('Total Research, Development, Test, & Evaluation 29,452,514 34,536,373 120,745');
    expect(row).toBeNull();
  });

  it('a summary/recap line naming an organization, not a PE, is never mistaken for a PE row', () => {
    const row = reconstructR1RowFromLine('Chemical and Biological Defense Program 1,050,175 1,257,964 1,257,964 1,398,625');
    expect(row).toBeNull();
  });

  it('narrative text containing a PE-like token mid-sentence is never mistaken for a data row (the line must START with lineNo + PE code)', () => {
    const row = reconstructR1RowFromLine(
      'See program element 0601102A for further detail on this initiative.',
    );
    expect(row).toBeNull();
  });

  it('a line with a valid PE code but no recognizable budget-activity/category anchor before the numbers -> no row (cannot trust the split)', () => {
    const row = reconstructR1RowFromLine('1 0601102A Defense Research Sciences 358,521 391,642 391,642 296,670');
    expect(row).toBeNull();
  });
});

describe('resolveComponent -- evidence-based mapping, never a document-wide default', () => {
  it('Army appropriation code', () => {
    expect(
      resolveComponent({
        headingLine: 'Department of the Army',
        appropriationLine: 'Appropriation: 2040A Research, Development, Test and Evaluation, Army',
      }),
    ).toEqual({ component: 'ARMY', evidence: expect.stringContaining('2040A') });
  });

  it('Navy appropriation code', () => {
    expect(
      resolveComponent({
        headingLine: 'Department of the Navy',
        appropriationLine: 'Appropriation: 1319N Research, Development, Test and Evaluation, Navy',
      }).component,
    ).toBe('NAVY');
  });

  it('Air Force vs Space Force disambiguated by exact appropriation code, not just the "Air Force" heading', () => {
    expect(
      resolveComponent({
        headingLine: 'Department of the Air Force',
        appropriationLine: 'Appropriation: 3600F Research, Development, Test and Evaluation, Air Force',
      }).component,
    ).toBe('AF');
    expect(
      resolveComponent({
        headingLine: 'Department of the Air Force',
        appropriationLine: 'Appropriation: 3620F Research, Development, Test, and Evaluation, Space Force',
      }).component,
    ).toBe('SF');
  });

  it('a specific agency heading with a dedicated enum value (DARPA/DHA/MDA/SOCOM) is used directly', () => {
    expect(
      resolveComponent({ headingLine: 'Defense Advanced Research Projects Agency', appropriationLine: undefined })
        .component,
    ).toBe('DARPA');
    expect(resolveComponent({ headingLine: 'Defense Health Agency', appropriationLine: undefined }).component).toBe(
      'DHA',
    );
  });

  it('an unrecognized specific office/agency name under a D-suffixed appropriation resolves to DW, evidenced by the appropriation code -- never a guessed specific agency, never a service branch default', () => {
    const result = resolveComponent({
      headingLine: 'Secretary of Defense',
      appropriationLine: 'Appropriation: 0400D Research, Development, Test and Evaluation, Defense-Wide',
    });
    expect(result.component).toBe('DW');
    expect(result.evidence).toMatch(/0400D/);
  });

  it('no appropriation code and no recognized heading -> UNKNOWN, never defaulted to a service branch', () => {
    expect(resolveComponent({ headingLine: undefined, appropriationLine: undefined }).component).toBe('UNKNOWN');
  });
});

describe('reconstructR1TablesFromTextV1 -- page-level behavior', () => {
  const REAL_PAGE_9_TEXT = [
    'UNCLASSIFIED',
    'Department of the Army',
    "FY 2024 President's Budget",
    "Exhibit R-1 FY 2024 President's Budget",
    'Total Obligational Authority Mar 2023',
    '(Dollars in Thousands)',
    'Appropriation: 2040A Research, Development, Test and Evaluation, Army',
    'Program FY 2023 Less FY 2023',
    'Line Element Se FY 2022 Supplementals Supplementals FY 2023 Total FY 2024',
    'No Number Item Act c Actuals Enacted Enacted* Enacted Request',
    '1 0601102A Defense Research Sciences 01 U 358,521 391,642 391,642 296,670',
    '2 0601103A University Research Initiatives 01 U 88,797 107,160 107,160 75,672',
  ].join('\n');

  it('a page with the canonical header and real data lines produces one reconstructed table with ARMY component', () => {
    const result = reconstructR1TablesFromTextV1([emptyPage({ page: 9, text: REAL_PAGE_9_TEXT })], 2024);
    expect(result.pages).toHaveLength(1);
    const page = result.pages[0]!;
    expect(page.component).toBe('ARMY');
    expect(page.dataRowCount).toBe(2);
    expect(page.confidentFundingRowCount).toBe(2);
    const requestCell = page.table.cells.find(
      (c) => c.rowIndex === 1 && c.columnIndex === R1_RECONSTRUCTED_COLUMNS.fyRequest,
    );
    expect(requestCell?.text).toBe('296,670');
    // Header column text is present and classifier-friendly.
    const headerRequestCell = page.table.cells.find(
      (c) => c.rowIndex === 0 && c.columnIndex === R1_RECONSTRUCTED_COLUMNS.fyRequest,
    );
    expect(headerRequestCell?.text).toBe('FY 2024 Request');
  });

  it('a page whose parser output already has structural tables is left untouched (never overridden)', () => {
    const page = emptyPage({
      page: 5,
      text: REAL_PAGE_9_TEXT,
      tables: [{ tableIndex: 0, rowCount: 1, columnCount: 1, cells: [], warnings: [] }],
    });
    const result = reconstructR1TablesFromTextV1([page], 2024);
    expect(result.pages).toHaveLength(0);
  });

  it('a page with no recognizable R-1 header at all produces nothing (missing FY header -> no reconstruction attempted)', () => {
    const page = emptyPage({ page: 3, text: 'THIS PAGE INTENTIONALLY LEFT BLANK' });
    const result = reconstructR1TablesFromTextV1([page], 2024);
    expect(result.pages).toHaveLength(0);
  });

  it('rows with ambiguous funding produce an omission, not a fabricated request value', () => {
    const text = REAL_PAGE_9_TEXT + '\n90 0305251A Cyberspace Operations Forces and Force Support 04 U 55,895 55,599 55,599';
    const result = reconstructR1TablesFromTextV1([emptyPage({ page: 9, text })], 2024);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]!.peCode).toBe('0305251A');
    const page = result.pages[0]!;
    expect(page.dataRowCount).toBe(3);
    expect(page.confidentFundingRowCount).toBe(2); // the ambiguous row's identity is captured but not its funding
  });

  it('deterministic rerun: identical input produces byte-identical reconstructed cells', () => {
    const first = reconstructR1TablesFromTextV1([emptyPage({ page: 9, text: REAL_PAGE_9_TEXT })], 2024);
    const second = reconstructR1TablesFromTextV1([emptyPage({ page: 9, text: REAL_PAGE_9_TEXT })], 2024);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
