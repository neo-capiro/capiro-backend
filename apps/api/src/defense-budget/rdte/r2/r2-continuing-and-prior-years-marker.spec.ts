/**
 * Regression: two independent, previously-unrecognized R-2 cost-table
 * conventions were blocking real scoped-fact-review approvals for FY2024
 * Army RDT&E Vol I Budget Activity 2 (candidate
 * `9def0a42-79cb-5df5-8764-7b0f1d3de009`, run
 * `9c650ffc-e991-5798-91ba-8e25eae6af41`, source PDF
 * `RDTE-Vol 1-Budget Activity 2.pdf`). A real `commit:false` dry-run of
 * `ScopedFactReviewV1Service.review()` refused all three PE totals below via
 * `same_row_finding_on_approved_page`, because each PE's own "Total Program
 * Element" row (row 3) carried an omission the scoped-fact-review policy's
 * same-page independence gate cannot distinguish from a different-row
 * finding.
 *
 * Confirmed against the REAL production extraction artifact for this exact
 * candidate/run (read-only S3 fetch, no writes) -- these are the literal
 * omission records, not a paraphrase:
 *
 *   - PE 0602141A "Lethality Technology", page 57: two `invalid_number`
 *     omissions, row 3 cols 11/12, raw text "Continuing".
 *   - PE 0602386A "Biotechnology for Materials", page 528: the identical
 *     two `invalid_number` omissions, row 3 cols 11/12, raw text
 *     "Continuing".
 *   - PE 0602115A "Biomedical Technology", page 51: ONE `unresolved_column_role`
 *     omission, row 3 col 1, raw text "0.000".
 *
 * TWO DISTINCT root causes, confirmed independently (not assumed identical):
 *
 * 1) "Continuing" (cols 11/12 = Cost To Complete / Total Cost) is a real,
 *    standard Army R-2 convention: a program with no defined completion
 *    date prints "Continuing" instead of a discrete figure, because funding
 *    continues indefinitely. `NUMBER_RE` in r2-cost-table-extractor-v1.ts
 *    rejected it as `invalid_number` -- the column ROLE resolved correctly
 *    (cost_to_complete/total_cost), only the cell VALUE was wrongly treated
 *    as malformed.
 *
 * 2) "0.000" on page 51 is a red herring -- it is an ordinary, valid number
 *    (`NUMBER_RE`/`parseCanonicalDecimalString` both accept it fine, and the
 *    real production artifact already has dozens of successfully-parsed
 *    "0"/"0.000" cells elsewhere in this exact document). The REAL cause is
 *    upstream of the value check entirely: column 1 is the "Prior\nYears"
 *    cumulative-total column (the sum of all funding before the earliest
 *    year shown), which prints NO fiscal year at all by design.
 *    `classifyRdteColumn` requires an explicit fiscal year for every role
 *    except cost_to_complete/total_cost/quantity, so "Prior Years" fell all
 *    the way through to `role: 'unknown'` -- and ANY populated cell in that
 *    column (as opposed to the far more common blank/"-" cell) then raised
 *    `unresolved_column_role`, regardless of what the cell's value was.
 *
 * Fix:
 *   - r2-cost-table-extractor-v1.ts: recognize an exact "Continuing" cell as
 *     a legitimate non-value (like the existing "-"/em-dash placeholder
 *     skip), but ONLY for cost_to_complete/total_cost roles -- the same text
 *     in an FY-bearing column is still a genuine `invalid_number`.
 *   - rdte-header-normalizer.ts: recognize the literal phrase "Prior Year(s)"
 *     as a new `prior_years_cumulative` fiscalLabelKind (distinct from the
 *     existing bare-token `PY` -> `prior_year_relative`, a single specific
 *     year).
 *   - rdte-column-classifier.ts: map `prior_years_cumulative` to the
 *     EXISTING `prior_actual_context` role (already historical/contextual,
 *     never canonical) with NO fiscal year -- inventing one would
 *     misrepresent a multi-year lump sum as a single year's actual spend.
 *   - r2-cost-table-extractor-v1.ts: exempt ONLY
 *     `prior_actual_context` + `fiscalYear == null` from the
 *     missing-fiscal-year gate -- a real single-year "actual" column always
 *     carries an explicit fiscal year by construction, so this cannot mask
 *     a genuine defect on that path.
 */
import type { ParserPageResultV1, ParsedTableV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { extractR2PeFunding, type R2PeContextV1 } from './r2-cost-table-extractor-v1.js';

const CYCLE_FY = 2024;

type Cell = { rowIndex: number; columnIndex: number; text: string };

function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  return {
    tableIndex,
    rowCount: Math.max(...cells.map((c) => c.rowIndex)) + 1,
    columnCount: Math.max(...cells.map((c) => c.columnIndex)) + 1,
    cells,
    warnings: [],
  };
}

function makePage(tables: ParsedTableV1[], page: number): ParserPageResultV1 {
  return {
    page,
    text: '$ in Millions',
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function peContext(peCode: string, page: number, title: string): R2PeContextV1 {
  return { peCode, pageStart: page, pageEnd: page, title };
}

/** The real column shape confirmed via the production artifact: 0=label,
 * 1=Prior Years (cumulative, no FY), 2=FY2022, 3=FY2023, 4=FY2024 Base,
 * 5=FY2024 OCO, 6=FY2024 Total, 7=FY2025, 8=FY2026, 9=FY2027, 10=FY2028,
 * 11=Cost To Complete, 12=Total Cost. */
function realCostTableHeaderCells(): Cell[] {
  return [
    { rowIndex: 0, columnIndex: 0, text: 'COST ($ in Millions)' },
    { rowIndex: 0, columnIndex: 1, text: 'Prior\nYears' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2022' },
    { rowIndex: 0, columnIndex: 3, text: 'FY 2023' },
    { rowIndex: 0, columnIndex: 4, text: 'FY 2024\nBase' },
    { rowIndex: 0, columnIndex: 5, text: 'FY 2024\nOCO' },
    { rowIndex: 0, columnIndex: 6, text: 'FY 2024\nTotal' },
    { rowIndex: 0, columnIndex: 7, text: 'FY 2025' },
    { rowIndex: 0, columnIndex: 8, text: 'FY 2026' },
    { rowIndex: 0, columnIndex: 9, text: 'FY 2027' },
    { rowIndex: 0, columnIndex: 10, text: 'FY 2028' },
    { rowIndex: 0, columnIndex: 11, text: 'Cost To\nComplete' },
    { rowIndex: 0, columnIndex: 12, text: 'Total\nCost' },
  ];
}

describe('R-2 real production convention: "Continuing" cost-to-complete/total-cost marker', () => {
  it('DEFECT (PE 0602141A page 57 shape): "Continuing" in Cost To Complete/Total Cost on the PE-total row is recognized, not invalid_number', () => {
    const cells: Cell[] = [
      ...realCostTableHeaderCells(),
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '20.000' },
      { rowIndex: 3, columnIndex: 2, text: '82.181' },
      { rowIndex: 3, columnIndex: 3, text: '80.578' },
      { rowIndex: 3, columnIndex: 4, text: '85.578' },
      { rowIndex: 3, columnIndex: 5, text: '-' },
      { rowIndex: 3, columnIndex: 6, text: '85.578' },
      { rowIndex: 3, columnIndex: 7, text: '86.406' },
      { rowIndex: 3, columnIndex: 8, text: '84.219' },
      { rowIndex: 3, columnIndex: 9, text: '96.819' },
      { rowIndex: 3, columnIndex: 10, text: '90.123' },
      // Pre-fix: both of these raised `invalid_number`.
      { rowIndex: 3, columnIndex: 11, text: 'Continuing' },
      { rowIndex: 3, columnIndex: 12, text: 'Continuing' },
    ];
    const page = makePage([makeTable(cells)], 57);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0602141A', 57, 'Lethality Technology'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([]);
    // Confirmed against the real artifact: with an explicit Base/OCO/Total
    // split (real for this PE -- OCO is "-", skipped like any dash), the
    // "Continuing" columns never carry a value at all (there is nothing
    // lawful to report), while every other real column on the row --
    // including the PE's own FY2024 Base/Total figures, unaffected by this
    // fix -- still extracts cleanly.
    expect(result.values.some((v) => v.columnRole === 'cost_to_complete')).toBe(false);
    expect(result.values.some((v) => v.columnRole === 'total_cost')).toBe(false);
    const fy2024Base = result.values.find((v) => v.columnIndex === 4);
    const fy2024Total = result.values.find((v) => v.columnIndex === 6);
    expect(fy2024Base?.originalValue).toBe('85.578');
    expect(fy2024Total?.originalValue).toBe('85.578');
    expect(fy2024Base?.disposition).toBe('contextual_only');
  });

  it('DEFECT (PE 0602386A page 528 shape): identical "Continuing" pattern on a different PE/page is also recognized', () => {
    const cells: Cell[] = [
      ...realCostTableHeaderCells(),
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '19.889' },
      { rowIndex: 3, columnIndex: 2, text: '19.889' },
      { rowIndex: 3, columnIndex: 3, text: '20.100' },
      { rowIndex: 3, columnIndex: 4, text: '19.969' },
      { rowIndex: 3, columnIndex: 5, text: '-' },
      { rowIndex: 3, columnIndex: 6, text: '19.969' },
      { rowIndex: 3, columnIndex: 7, text: '16.736' },
      { rowIndex: 3, columnIndex: 8, text: '17.001' },
      { rowIndex: 3, columnIndex: 9, text: '7.360' },
      { rowIndex: 3, columnIndex: 10, text: '9.500' },
      { rowIndex: 3, columnIndex: 11, text: 'Continuing' },
      { rowIndex: 3, columnIndex: 12, text: 'Continuing' },
    ];
    const page = makePage([makeTable(cells)], 528);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0602386A', 528, 'Biotechnology for Materials - Applied Research'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([]);
    const fy2024Base = result.values.find((v) => v.columnIndex === 4);
    expect(fy2024Base?.originalValue).toBe('19.969');
  });

  it('NEGATIVE CONTROL: "Continuing" in an FY-bearing (annual) column is still a genuine invalid_number -- the fix does not blanket-suppress the omission', () => {
    const cells: Cell[] = [
      ...realCostTableHeaderCells(),
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '1.000' },
      { rowIndex: 3, columnIndex: 2, text: '1.000' },
      { rowIndex: 3, columnIndex: 3, text: '1.000' },
      // A real appropriation figure is never legitimately "Continuing" --
      // this must still be flagged.
      { rowIndex: 3, columnIndex: 4, text: 'Continuing' },
      { rowIndex: 3, columnIndex: 5, text: '-' },
      { rowIndex: 3, columnIndex: 6, text: '1.000' },
      { rowIndex: 3, columnIndex: 7, text: '1.000' },
      { rowIndex: 3, columnIndex: 8, text: '1.000' },
      { rowIndex: 3, columnIndex: 9, text: '1.000' },
      { rowIndex: 3, columnIndex: 10, text: '1.000' },
      { rowIndex: 3, columnIndex: 11, text: '5.000' },
      { rowIndex: 3, columnIndex: 12, text: '10.000' },
    ];
    const page = makePage([makeTable(cells)], 900);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0699999A', 900, 'Negative Control PE'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([
      expect.objectContaining({ reason: 'invalid_number', rawText: 'Continuing', columnIndex: 4 }),
    ]);
    expect(result.values.some((v) => v.columnRole === 'budget_year_request')).toBe(false);
  });
});

describe('R-2 real production convention: "Prior Years" cumulative column (no single fiscal year)', () => {
  it('DEFECT (PE 0602115A page 51 shape): a populated Prior Years cell on the PE-total row is recognized, not unresolved_column_role', () => {
    const cells: Cell[] = [
      ...realCostTableHeaderCells(),
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      // Pre-fix: this raised `unresolved_column_role` (the "0.000" text
      // itself was never even reached by the numeric check).
      { rowIndex: 3, columnIndex: 1, text: '0.000' },
      { rowIndex: 3, columnIndex: 2, text: '0.000' },
      { rowIndex: 3, columnIndex: 3, text: '0.000' },
      { rowIndex: 3, columnIndex: 4, text: '0.000' },
      { rowIndex: 3, columnIndex: 5, text: '0.000' },
      { rowIndex: 3, columnIndex: 6, text: '0.000' },
      { rowIndex: 3, columnIndex: 7, text: '0.000' },
      { rowIndex: 3, columnIndex: 8, text: '0.000' },
      { rowIndex: 3, columnIndex: 9, text: '0.000' },
      { rowIndex: 3, columnIndex: 10, text: '0.000' },
      { rowIndex: 3, columnIndex: 11, text: '0.000' },
      { rowIndex: 3, columnIndex: 12, text: '11.489' },
    ];
    const page = makePage([makeTable(cells)], 51);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0602115A', 51, 'Biomedical Technology'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([]);
    const priorYears = result.values.find(
      (v) => v.columnIndex === 1 && v.rowKind === 'pe_total',
    );
    expect(priorYears?.columnRole).toBe('prior_actual_context');
    expect(priorYears?.disposition).toBe('contextual_only');
    expect(priorYears?.originalValue).toBe('0');
    expect(priorYears?.fiscalYear).toBeUndefined();

    // The PE's own FY2024 figure (col 4) still extracts cleanly and
    // truthfully as a real (zero) value -- this program genuinely has no
    // FY2024 funding, which is exactly why the dry-run flagged it as worth
    // double-checking, not because it's wrong.
    const fy2024Base = result.values.find((v) => v.columnIndex === 4);
    expect(fy2024Base?.originalValue).toBe('0');
  });

  it('NEGATIVE CONTROL: a genuinely unresolvable header is still unresolved_column_role -- the fix does not blanket-suppress the omission', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'COST ($ in Millions)' },
      // Not "Prior Years", not a fiscal-year label, not a component/stage
      // label -- a genuinely unclassifiable header.
      { rowIndex: 0, columnIndex: 1, text: 'Miscellaneous Adjustment Code' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '3.500' },
      { rowIndex: 3, columnIndex: 2, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 901);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0699998A', 901, 'Negative Control PE 2'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([
      expect.objectContaining({
        reason: 'unresolved_column_role',
        rawText: '3.500',
        columnIndex: 1,
      }),
    ]);
  });

  it('NEGATIVE CONTROL: a bare "PY" single-year label still resolves to a real fiscal year, distinct from the "Prior Years" cumulative label', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'COST ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'PY' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '2.500' },
      { rowIndex: 3, columnIndex: 2, text: '3.000' },
    ];
    const page = makePage([makeTable(cells)], 902);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext('0699997A', 902, 'Negative Control PE 3'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions).toEqual([]);
    const py = result.values.find((v) => v.columnIndex === 1);
    expect(py?.columnRole).toBe('prior_actual_context');
    expect(py?.fiscalYear).toBe(CYCLE_FY - 1);
    expect(py?.disposition).toBe('contextual_only');
  });
});
