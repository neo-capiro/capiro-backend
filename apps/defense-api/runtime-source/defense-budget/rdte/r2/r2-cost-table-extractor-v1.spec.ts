/**
 * r2-cost-table-extractor-v1.spec — Workstream G tests.
 *
 * Synthetic/golden fixtures for:
 *   - standard R-2 cost table;
 *   - authoritative "Total Program Element" row;
 *   - base/OCO/total component rows;
 *   - multi-page continued table with repeated headers;
 *   - missing total (never derived);
 *   - cost-to-complete / total cost;
 *   - actual/enacted context (never canonical);
 *   - outyear projections (pe_budget_position);
 *   - zero values;
 *   - negative reprogramming context;
 *   - R-1/R-2 agreement and disagreement comparison requests.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import {
  buildR2R1ComparisonRequests,
  extractR2PeFunding,
  type R2PeContextV1,
} from './r2-cost-table-extractor-v1.js';
import { buildR2PeFundingArtifact } from './r2-pe-funding-builder.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';

const CYCLE_FY = 2027;
const SHA = 'e'.repeat(64);
const PE = '0601101A';

type Cell = { rowIndex: number; columnIndex: number; text: string };

function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return { tableIndex, rowCount, columnCount, cells, warnings: [] };
}

function makePage(
  tables: ParsedTableV1[],
  page: number,
  text?: string,
  printedPage?: string,
): ParserPageResultV1 {
  return {
    page,
    ...(text != null ? { text } : {}),
    ...(printedPage != null ? { printedPage } : {}),
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function peContext(pageStart: number, pageEnd: number): R2PeContextV1 {
  return { peCode: PE, pageStart, pageEnd, title: 'Research Project' };
}

function makeSource(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'r2_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/r2.pdf',
    fiscalYear: CYCLE_FY,
    family: 'rdte',
    exhibit: 'R-2',
    authority: 'dod-comptroller',
    component: 'ARMY',
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

/** Standard R-2 cost table: full FYDP + CTC/total-cost, one PE total row. */
function standardCostTableCells(): Cell[] {
  return [
    { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
    { rowIndex: 0, columnIndex: 1, text: 'FY 2025 Actual' },
    { rowIndex: 0, columnIndex: 2, text: 'FY 2026 Enacted' },
    { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Request' },
    { rowIndex: 0, columnIndex: 4, text: 'FY 2028' },
    { rowIndex: 0, columnIndex: 5, text: 'FY 2029' },
    { rowIndex: 0, columnIndex: 6, text: 'Cost to Complete' },
    { rowIndex: 0, columnIndex: 7, text: 'Total Cost' },
    { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
    { rowIndex: 1, columnIndex: 1, text: '10.000' },
    { rowIndex: 1, columnIndex: 2, text: '11.000' },
    { rowIndex: 1, columnIndex: 3, text: '12.000' },
    { rowIndex: 1, columnIndex: 4, text: '13.000' },
    { rowIndex: 1, columnIndex: 5, text: '14.000' },
    { rowIndex: 1, columnIndex: 6, text: '5.000' },
    { rowIndex: 1, columnIndex: 7, text: '65.000' },
  ];
}

describe('r2-cost-table-extractor-v1', () => {
  it('extracts a standard R-2 cost table with full FYDP roles', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.peCode).toBe(PE);
    expect(result.values).toHaveLength(7);
    const byRole = new Map(result.values.map((v) => [v.columnRole, v]));

    const actual = byRole.get('prior_actual_context');
    expect(actual?.originalValue).toBe('10');
    expect(actual?.disposition).toBe('contextual_only');
    expect(actual?.fiscalYear).toBe(2025);

    const enacted = byRole.get('current_enacted_context');
    expect(enacted?.originalValue).toBe('11');
    expect(enacted?.disposition).toBe('contextual_only');

    const request = byRole.get('budget_year_request');
    expect(request?.originalValue).toBe('12');
    expect(request?.disposition).toBe('canonical_request_candidate');
    expect(request?.fiscalYear).toBe(2027);
    expect(request?.rowKind).toBe('pe_total');
    expect(request?.direct).toBe(true);

    const outyears = result.values.filter((v) => v.columnRole === 'outyear_projection');
    expect(outyears.map((v) => v.fiscalYear).sort()).toEqual([2028, 2029]);
    for (const oy of outyears) {
      expect(oy.disposition).toBe('pe_budget_position');
    }

    const ctc = byRole.get('cost_to_complete');
    expect(ctc?.disposition).toBe('non_annual_cost');
    expect(ctc?.fiscalYear).toBeUndefined();

    const totalCost = byRole.get('total_cost');
    expect(totalCost?.originalValue).toBe('65');
    expect(totalCost?.disposition).toBe('non_annual_cost');

    expect(result.requestKeys).toEqual([{ peCode: PE, fiscalYear: 2027 }]);
    expect(result.omissions).toHaveLength(0);
  });

  it('identifies the Total Program Element row as the authoritative PE total', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const peTotalValues = result.values.filter((v) => v.rowKind === 'pe_total');
    expect(peTotalValues).toHaveLength(7);
    for (const v of peTotalValues) {
      expect(v.peCode).toBe(PE);
    }
  });

  it('handles base/OCO/total component rows as contextual components', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Base' },
      { rowIndex: 1, columnIndex: 1, text: '10.000' },
      { rowIndex: 2, columnIndex: 0, text: 'OCO' },
      { rowIndex: 2, columnIndex: 1, text: '2.000' },
      { rowIndex: 3, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 3, columnIndex: 1, text: '12.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(3);
    const base = result.values.find((v) => v.rowKind === 'base_component');
    const oco = result.values.find((v) => v.rowKind === 'oco_component');
    const total = result.values.find((v) => v.rowKind === 'pe_total');

    expect(base?.componentContext).toBe('base');
    expect(base?.disposition).toBe('canonical_request_candidate');
    expect(oco?.componentContext).toBe('oco');
    expect(total?.componentContext).toBe('none');
    expect(total?.originalValue).toBe('12');
  });

  it('handles base/OCO/total split COLUMNS as contextual components', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Base' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 OCO' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Total' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '10.000' },
      { rowIndex: 1, columnIndex: 2, text: '2.000' },
      { rowIndex: 1, columnIndex: 3, text: '12.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(3);
    const byRole = new Map(result.values.map((v) => [v.columnRole, v]));
    expect(byRole.get('base_component')?.disposition).toBe('contextual_only');
    expect(byRole.get('oco_component')?.disposition).toBe('contextual_only');
    expect(byRole.get('total_component')?.disposition).toBe('contextual_only');
    expect(byRole.get('base_component')?.componentContext).toBe('base');
    expect(byRole.get('oco_component')?.componentContext).toBe('oco');
    expect(byRole.get('total_component')?.componentContext).toBe('total');
    /* base/OCO split components must never become canonical request. */
    expect(result.requestKeys).toHaveLength(0);
  });

  it('stitches multi-page continued tables with repeated headers without double extraction', () => {
    const page1Cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2025 Actual' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2026 Enacted' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '10.000' },
      { rowIndex: 1, columnIndex: 2, text: '11.000' },
      { rowIndex: 1, columnIndex: 3, text: '12.000' },
      { rowIndex: 2, columnIndex: 0, text: 'Total Program Element (continued)' },
    ];
    const page2Cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'Cost to Complete' },
      { rowIndex: 0, columnIndex: 2, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '5.000' },
      { rowIndex: 1, columnIndex: 2, text: '40.000' },
    ];
    const page1 = makePage([makeTable(page1Cells)], 1, '$ in Millions', 'R-2-10');
    const page2 = makePage([makeTable(page2Cells)], 2, '$ in Millions', 'R-2-11');
    const result = extractR2PeFunding({
      pages: [page1, page2],
      peContext: peContext(1, 2),
      cycleFiscalYear: CYCLE_FY,
    });

    /* First-page values extracted once. */
    const request = result.values.find((v) => v.columnRole === 'budget_year_request');
    expect(request?.originalValue).toBe('12');

    /* The page-1 "Total Program Element (continued)" marker row and the
     * page-2 repeated "Total Program Element" row are both continuation
     * context — the PE total is extracted exactly once. */
    const continuationNotes = result.omissions.filter((o) => o.reason === 'continuation_row');
    expect(continuationNotes).toHaveLength(2);
    expect(continuationNotes[1]?.page).toBe(2);

    const peTotalValues = result.values.filter((v) => v.rowKind === 'pe_total');
    expect(peTotalValues).toHaveLength(3);
  });

  it('treats repeated header rows as metadata, not data rows', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 1, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 2, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 2, columnIndex: 1, text: '12.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values).toHaveLength(1);
    expect(result.omissions.filter((o) => o.reason === 'repeated_header')).toHaveLength(1);
  });

  it('never derives a missing total from base/OCO components', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Base' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 OCO' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '10.000' },
      { rowIndex: 1, columnIndex: 2, text: '2.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });

    /* Only the two printed component values exist; no synthetic total. */
    expect(result.values).toHaveLength(2);
    for (const v of result.values) {
      expect(v.direct).toBe(true);
      expect(v.disposition).toBe('contextual_only');
    }
    expect(result.values.some((v) => v.originalValue === '12')).toBe(false);
  });

  it('captures cost-to-complete and total-cost as non-annual costs', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const ctc = result.values.find((v) => v.columnRole === 'cost_to_complete');
    const tc = result.values.find((v) => v.columnRole === 'total_cost');
    expect(ctc?.disposition).toBe('non_annual_cost');
    expect(tc?.disposition).toBe('non_annual_cost');
    expect(ctc?.fiscalYear).toBeUndefined();
    expect(tc?.fiscalYear).toBeUndefined();
    expect(ctc?.valueMillions).toBe('5');
  });

  it('keeps actual/enacted context out of any canonical stage', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const contextual = result.values.filter(
      (v) => v.columnRole === 'prior_actual_context' || v.columnRole === 'current_enacted_context',
    );
    expect(contextual).toHaveLength(2);
    for (const v of contextual) {
      expect(v.disposition).toBe('contextual_only');
    }
    /* Only FY2027 appears in request keys. */
    expect(result.requestKeys).toEqual([{ peCode: PE, fiscalYear: 2027 }]);
  });

  it('maps outyear projections to pe_budget_position with asserted fiscal years', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const outyears = result.values.filter((v) => v.columnRole === 'outyear_projection');
    expect(outyears).toHaveLength(2);
    expect(outyears.map((v) => v.fiscalYear).sort()).toEqual([2028, 2029]);
    for (const v of outyears) {
      expect(v.disposition).toBe('pe_budget_position');
    }
  });

  it('handles zero values', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '0.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values).toHaveLength(1);
    expect(result.values[0]?.originalValue).toBe('0');
    expect(result.values[0]?.disposition).toBe('canonical_request_candidate');
  });

  it('handles negative reprogramming context values', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2026 Enacted' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '-1.500' },
      { rowIndex: 1, columnIndex: 2, text: '12.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const enacted = result.values.find((v) => v.columnRole === 'current_enacted_context');
    expect(enacted?.originalValue).toBe('-1.5');
    expect(enacted?.valueMillions).toBe('-1.5');
    expect(enacted?.disposition).toBe('contextual_only');
  });

  it('extracts project rows with project context', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '12.000' },
      { rowIndex: 2, columnIndex: 0, text: 'A1' },
      { rowIndex: 2, columnIndex: 1, text: '7.000' },
      { rowIndex: 3, columnIndex: 0, text: 'B2' },
      { rowIndex: 3, columnIndex: 1, text: '5.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });

    const peTotal = result.values.filter((v) => v.rowKind === 'pe_total');
    const projects = result.values.filter((v) => v.rowKind === 'project');
    expect(peTotal).toHaveLength(1);
    expect(projects).toHaveLength(2);
    expect(projects[0]?.projectCode).toBe('A1');
    expect(projects[1]?.projectCode).toBe('B2');
    /* Project request values are direct PE-section evidence for the R-2
     * cost table; project-level rollup verification happens in a later
     * workstream. */
    for (const p of projects) {
      expect(p.disposition).toBe('canonical_request_candidate');
    }
  });

  it('converts units exactly (thousands to millions)', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '12,500' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Thousands');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values[0]?.originalUnit).toBe('thousands');
    expect(result.values[0]?.originalValue).toBe('12500');
    expect(result.values[0]?.valueMillions).toBe('12.5');
  });

  it('omits money cells when the unit is missing', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1);
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values).toHaveLength(0);
    expect(result.unitResolution.status).toBe('missing');
    expect(result.omissions.some((o) => o.reason === 'missing_unit')).toBe(true);
  });

  it('omits cells with unresolved column roles', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'Fiscal Year Data' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '12.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'unresolved_column_role')).toBe(true);
  });

  it('scopes extraction to the PE page range only', () => {
    const page1 = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const otherCells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '99.000' },
    ];
    const page2 = makePage([makeTable(otherCells)], 2, '$ in Millions');
    const result = extractR2PeFunding({
      pages: [page1, page2],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(result.values.every((v) => v.originalValue !== '99')).toBe(true);
  });

  it('is deterministic under page input permutation', () => {
    const cellsA: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '12.000' },
    ];
    const cellsB: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2028' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '13.000' },
    ];
    const page1 = makePage([makeTable(cellsA)], 1, '$ in Millions');
    const page2 = makePage([makeTable(cellsB)], 2, '$ in Millions');

    const resultA = extractR2PeFunding({
      pages: [page1, page2],
      peContext: peContext(1, 2),
      cycleFiscalYear: CYCLE_FY,
    });
    const resultB = extractR2PeFunding({
      pages: [page1, page2],
      peContext: peContext(1, 2),
      cycleFiscalYear: CYCLE_FY,
    });

    const sortValues = (r: typeof resultA) =>
      [...r.values].sort(
        (a, b) =>
          a.page - b.page ||
          a.rowIndex - b.rowIndex ||
          a.columnIndex - b.columnIndex ||
          a.columnRole.localeCompare(b.columnRole),
      );
    expect(sortValues(resultA)).toEqual(sortValues(resultB));
  });
});

describe('buildR2R1ComparisonRequests', () => {
  function r2ResultWithRequest(valueMillions: string, page = 1) {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: valueMillions },
    ];
    const p = makePage([makeTable(cells)], page, '$ in Millions');
    return extractR2PeFunding({
      pages: [p],
      peContext: peContext(page, page),
      cycleFiscalYear: CYCLE_FY,
    });
  }

  it('creates one comparison request per PE/FY present in both R-1 and R-2 (agreement case)', () => {
    const r2 = r2ResultWithRequest('12.000');
    const r1Keys = new Set(['0601101A|2027']);
    const requests = buildR2R1ComparisonRequests({
      r2Results: [r2],
      r1RequestKeys: r1Keys,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.comparisonKind).toBe('r1_r2_pe_funding_agreement');
    expect(requests[0]?.peCode).toBe(PE);
    expect(requests[0]?.fiscalYear).toBe(2027);
    expect(requests[0]?.field).toBe('request');
    expect(requests[0]?.r2ValueMillions).toBe('12');
    expect(requests[0]?.r1ReferenceKey).toEqual({
      peCode: PE,
      fiscalYear: 2027,
      field: 'request',
    });
    expect(requests[0]?.r2Evidence.page).toBe(1);
  });

  it('creates comparison requests even when R-1 and R-2 disagree (disagreement resolves in Phase 2)', () => {
    /* R-2 says 12.0M; R-1 key exists with a different printed value.
     * The comparison REQUEST is created for the shared PE/FY regardless —
     * agreement evaluation belongs to the Phase 2 comparison rule, which
     * reads both artifacts independently. */
    const r2 = r2ResultWithRequest('12.500');
    const r1Keys = new Set(['0601101A|2027']);
    const requests = buildR2R1ComparisonRequests({
      r2Results: [r2],
      r1RequestKeys: r1Keys,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.r2ValueMillions).toBe('12.5');
  });

  it('creates NO comparison request for PE/FY present only in R-2', () => {
    const r2 = r2ResultWithRequest('12.000');
    const requests = buildR2R1ComparisonRequests({
      r2Results: [r2],
      r1RequestKeys: new Set(['0601999A|2027']),
    });
    expect(requests).toHaveLength(0);
  });

  it('deduplicates comparison requests when the same PE/FY appears twice', () => {
    const r2a = r2ResultWithRequest('12.000', 1);
    const r2b = r2ResultWithRequest('12.000', 5);
    const requests = buildR2R1ComparisonRequests({
      r2Results: [r2a, r2b],
      r1RequestKeys: new Set(['0601101A|2027']),
    });
    expect(requests).toHaveLength(1);
  });
});

describe('r2-pe-funding-builder', () => {
  it('builds a valid artifact: request is a funding assertion, everything else document_fact', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const artifact = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });

    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions).toHaveLength(1);
    if (fundingAssertions[0]?.assertionKind === 'funding') {
      expect(fundingAssertions[0].field).toBe('request');
      expect(fundingAssertions[0].fiscalYear).toBe(2027);
      expect(fundingAssertions[0].money.originalValue).toBe('12');
      expect(fundingAssertions[0].money.originalUnit).toBe('millions');
      expect(fundingAssertions[0].metadata?.['disposition']).toBe('canonical_request_candidate');
      expect(fundingAssertions[0].metadata?.['rowKind']).toBe('pe_total');
    }

    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    /* actual, enacted, 2 outyears, CTC, total-cost = 6 */
    expect(docFacts).toHaveLength(6);
    const fieldNames = docFacts
      .map((a) => (a.assertionKind === 'document_fact' ? a.fieldName : ''))
      .sort();
    expect(fieldNames).toEqual([
      'r2_cost_to_complete',
      'r2_current_enacted_context',
      'r2_outyear_projection',
      'r2_outyear_projection',
      'r2_prior_actual_context',
      'r2_total_cost',
    ]);
  });

  it('never projects actual/enacted/base/OCO values to a canonical funding stage', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2025 Actual' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2026 Enacted' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2027 Base' },
      { rowIndex: 0, columnIndex: 4, text: 'FY 2027 OCO' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '10.000' },
      { rowIndex: 1, columnIndex: 2, text: '11.000' },
      { rowIndex: 1, columnIndex: 3, text: '10.000' },
      { rowIndex: 1, columnIndex: 4, text: '2.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const artifact = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });

    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions).toHaveLength(0);
    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(docFacts).toHaveLength(4);
  });

  it('emits a blocking warning when unit resolution fails', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1);
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const artifact = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });
    const unitWarnings = artifact.warnings.filter((w) => w.code === 'r2_unit_unresolved');
    expect(unitWarnings).toHaveLength(1);
    expect(unitWarnings[0]?.severity).toBe('blocking');
  });

  it('builds evidence-linked comparison assertions with independent R-1 reference keys', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const requests = buildR2R1ComparisonRequests({
      r2Results: [extraction],
      r1RequestKeys: new Set(['0601101A|2027']),
    });
    const artifact = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      comparisonRequests: requests,
      cycleFiscalYear: CYCLE_FY,
    });

    const comparisonAssertions = artifact.assertions.filter(
      (a) =>
        a.assertionKind === 'document_fact' && a.fieldName === 'r1_r2_pe_funding_agreement_request',
    );
    expect(comparisonAssertions).toHaveLength(1);
    const assertion = comparisonAssertions[0];
    if (assertion?.assertionKind === 'document_fact') {
      const value = assertion.value as Record<string, unknown>;
      expect(value['comparisonKind']).toBe('r1_r2_pe_funding_agreement');
      expect(value['r2ValueMillions']).toBe('12');
      /* R-2 evidence identity is fully recorded on this side. */
      const r2Evidence = value['r2Evidence'] as Record<string, unknown>;
      expect(r2Evidence['page']).toBe(1);
      expect(r2Evidence['tableIndex']).toBe(0);
      /* R-1 side is a natural key only — its artifact identity is resolved
       * by Phase 2's independent reference mechanism, never copied here. */
      const r1Key = value['r1ReferenceKey'] as Record<string, unknown>;
      expect(r1Key).toEqual({ peCode: PE, fiscalYear: 2027, field: 'request' });
      expect(value['independence']).toBe('cross_document_independent_reference');
      expect(value['r2SourcePdfSha256']).toBe(SHA);
      /* Comparison assertion carries evidence IDs (evidence-linked). */
      expect(assertion.evidenceIds.length).toBeGreaterThan(0);
      expect(artifact.evidence.some((e) => assertion.evidenceIds.includes(e.evidenceId))).toBe(
        true,
      );
    }
  });

  it('produces deterministic artifact IDs under repeated builds', () => {
    const page = makePage([makeTable(standardCostTableCells())], 1, '$ in Millions');
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    const artifactA = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });
    const artifactB = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });
    expect(artifactA.artifactId).toBe(artifactB.artifactId);
    expect(artifactA.contentSha256).toBe(artifactB.contentSha256);
  });

  it('builds an artifact from a multi-row table without duplicate-ID collisions', () => {
    /* Regression: two data rows on one page (pe_total + project) must produce
     * distinct evidence/fact/assertion IDs even when their role buckets match. */
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Program Element Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2028' },
      { rowIndex: 1, columnIndex: 0, text: 'Total Program Element' },
      { rowIndex: 1, columnIndex: 1, text: '100.0' },
      { rowIndex: 1, columnIndex: 2, text: '110.0' },
      { rowIndex: 2, columnIndex: 0, text: 'A1' },
      { rowIndex: 2, columnIndex: 1, text: '60.0' },
      { rowIndex: 2, columnIndex: 2, text: '66.0' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const extraction = extractR2PeFunding({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: CYCLE_FY,
    });
    expect(extraction.values).toHaveLength(4);

    const artifact = buildR2PeFundingArtifact({
      source: makeSource(),
      parserRuns: [],
      extractions: [extraction],
      cycleFiscalYear: CYCLE_FY,
    });

    /* pe_total request + project request = 2 funding assertions; the two
     * outyear positions = 2 document facts. */
    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions).toHaveLength(2);
    const docFacts = artifact.assertions.filter((a) => a.assertionKind === 'document_fact');
    expect(docFacts).toHaveLength(2);

    /* All IDs unique across the artifact. */
    const assertionIds = artifact.assertions.map((a) => a.assertionId);
    expect(new Set(assertionIds).size).toBe(assertionIds.length);
    const evidenceIds = artifact.evidence.map((e) => e.evidenceId);
    expect(new Set(evidenceIds).size).toBe(evidenceIds.length);
    const factIds = artifact.sourceFacts.map((f) => f.factId);
    expect(new Set(factIds).size).toBe(factIds.length);
  });
});
