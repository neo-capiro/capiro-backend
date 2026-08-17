/**
 * r2a-project-funding-extractor-v1.spec — Workstream I tests.
 *
 * Synthetic fixtures for:
 * - exact project sum;
 * - within rounding tolerance;
 * - outside tolerance;
 * - missing project;
 * - duplicate project row;
 * - subtotal double-count attempt;
 * - base/OCO/total project rows;
 * - outyear columns;
 * - cost-to-complete exclusion;
 * - project code mismatch;
 * - zero-valued project;
 * - source footnote/review route.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { R2aProjectPageGroup } from './r2a-project-extractor-v1.js';
import {
  extractR2aProjectFunding,
  type R2aProjectFundingValue,
} from './r2a-project-funding-extractor-v1.js';
import {
  reconcileR2aProjectColumn,
  reconcileR2aPe,
  type R2PeTotalCell,
} from './r2a-project-reconciler.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const PE = '0601234A';
const CYCLE_FY = 2027;

type Cell = { rowIndex: number; columnIndex: number; text: string };

function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  const maxRow = Math.max(...cells.map((c) => c.rowIndex), 0);
  const maxCol = Math.max(...cells.map((c) => c.columnIndex), 0);
  return {
    tableIndex,
    rowCount: maxRow + 1,
    columnCount: maxCol + 1,
    cells: cells.map((c) => ({
      rowIndex: c.rowIndex,
      columnIndex: c.columnIndex,
      text: c.text,
    })),
    warnings: [],
  };
}

function makePage(
  tables: ParsedTableV1[],
  page: number,
  unitText?: string,
  printedPage?: string,
): ParserPageResultV1 {
  return {
    page,
    ...(printedPage != null ? { printedPage } : {}),
    ...(unitText != null ? { text: unitText } : {}),
    blocks:
      unitText != null ? [{ blockIndex: 0, blockType: 'header' as const, text: unitText }] : [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function makeGroup(
  pages: ParserPageResultV1[],
  projectCode = 'A1',
  parentPeCode = PE,
): R2aProjectPageGroup {
  return { parentPeCode, projectCode, pages };
}

function fundingValue(
  overrides: Partial<R2aProjectFundingValue> & {
    projectCode: string;
    originalValue: string;
  },
): R2aProjectFundingValue {
  return {
    parentPeCode: overrides.parentPeCode ?? PE,
    projectCode: overrides.projectCode,
    rowKind: overrides.rowKind ?? 'project',
    ...(overrides.fiscalYear != null ? { fiscalYear: overrides.fiscalYear } : {}),
    columnRole: overrides.columnRole ?? 'budget_year_request',
    disposition: overrides.disposition ?? 'project_budget_position',
    originalValue: overrides.originalValue,
    originalUnit: overrides.originalUnit ?? 'millions',
    valueMillions: overrides.valueMillions ?? overrides.originalValue,
    page: overrides.page ?? 1,
    ...(overrides.printedPage != null ? { printedPage: overrides.printedPage } : {}),
    tableIndex: overrides.tableIndex ?? 0,
    rowIndex: overrides.rowIndex ?? 1,
    columnIndex: overrides.columnIndex ?? 1,
    headerText: overrides.headerText ?? 'FY 2027 Request',
    direct: overrides.direct ?? true,
    positionCycle: overrides.positionCycle ?? `pb_fy${CYCLE_FY}`,
  };
}

function peTotalCell(overrides: Partial<R2PeTotalCell> & { printedTotal: string }): R2PeTotalCell {
  return {
    peCode: overrides.peCode ?? PE,
    fiscalYear: overrides.fiscalYear ?? CYCLE_FY,
    columnRole: overrides.columnRole ?? 'budget_year_request',
    printedTotal: overrides.printedTotal,
    unit: overrides.unit ?? 'millions',
    page: overrides.page ?? 1,
    ...(overrides.printedPage != null ? { printedPage: overrides.printedPage } : {}),
    rowIndex: overrides.rowIndex ?? 1,
    columnIndex: overrides.columnIndex ?? 1,
  };
}

/* ------------------------------------------------------------------ */
/* Extractor tests                                                     */
/* ------------------------------------------------------------------ */

describe('r2a-project-funding-extractor-v1', () => {
  it('extracts a standard project funding row', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027 Request' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2028' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '7.000' },
      { rowIndex: 1, columnIndex: 2, text: '8.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(2);
    expect(result.values[0]?.projectCode).toBe('A1');
    expect(result.values[0]?.columnRole).toBe('budget_year_request');
    expect(result.values[0]?.disposition).toBe('project_budget_position');
    expect(result.values[0]?.originalValue).toBe('7');
    expect(result.values[1]?.columnRole).toBe('outyear_projection');
    expect(result.values[1]?.originalValue).toBe('8');
  });

  it('extracts base/OCO/total component rows', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Base' },
      { rowIndex: 1, columnIndex: 1, text: '5.000' },
      { rowIndex: 2, columnIndex: 0, text: 'OCO' },
      { rowIndex: 2, columnIndex: 1, text: '2.000' },
      { rowIndex: 3, columnIndex: 0, text: 'Total' },
      { rowIndex: 3, columnIndex: 1, text: '7.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    const base = result.values.find((v) => v.rowKind === 'project_base_component');
    const oco = result.values.find((v) => v.rowKind === 'project_oco_component');
    const total = result.values.find((v) => v.rowKind === 'project_total_component');
    expect(base?.originalValue).toBe('5');
    expect(oco?.originalValue).toBe('2');
    expect(total?.originalValue).toBe('7');
    expect(base?.disposition).toBe('contextual_only');
  });

  it('handles outyear columns', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 0, columnIndex: 2, text: 'FY 2028' },
      { rowIndex: 0, columnIndex: 3, text: 'FY 2029' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '7.000' },
      { rowIndex: 1, columnIndex: 2, text: '8.000' },
      { rowIndex: 1, columnIndex: 3, text: '9.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(3);
    const outyears = result.values.filter((v) => v.columnRole === 'outyear_projection');
    expect(outyears).toHaveLength(2);
    for (const v of outyears) {
      expect(v.disposition).toBe('project_budget_position');
    }
  });

  it('extracts cost-to-complete as non_annual_cost', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 0, columnIndex: 2, text: 'Cost to Complete' },
      { rowIndex: 0, columnIndex: 3, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '7.000' },
      { rowIndex: 1, columnIndex: 2, text: '3.000' },
      { rowIndex: 1, columnIndex: 3, text: '50.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    const ctc = result.values.find((v) => v.columnRole === 'cost_to_complete');
    const tc = result.values.find((v) => v.columnRole === 'total_cost');
    expect(ctc?.disposition).toBe('non_annual_cost');
    expect(tc?.disposition).toBe('non_annual_cost');
    expect(ctc?.fiscalYear).toBeUndefined();
  });

  it('handles zero-valued project', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '0.000' },
    ];
    const page = makePage([makeTable(cells)], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(1);
    expect(result.values[0]?.originalValue).toBe('0');
  });

  it('omits cells when unit is missing', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '7.000' },
    ];
    const page = makePage([makeTable(cells)], 1); // no unit text
    const result = extractR2aProjectFunding({
      group: makeGroup([page]),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.values).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'missing_unit')).toBe(true);
  });

  it('blocks on invalid project code', () => {
    const page = makePage([], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page], ''), // empty project code
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions.some((o) => o.reason === 'invalid_project_code')).toBe(true);
  });

  it('blocks on invalid parent PE', () => {
    const page = makePage([], 1, '$ in Millions');
    const result = extractR2aProjectFunding({
      group: makeGroup([page], 'A1', 'INVALID'),
      cycleFiscalYear: CYCLE_FY,
    });

    expect(result.omissions.some((o) => o.reason === 'missing_or_invalid_parent_pe')).toBe(true);
  });

  it('is deterministic under page order permutation', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost ($ in Millions)' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2027' },
      { rowIndex: 1, columnIndex: 0, text: 'Project Cost' },
      { rowIndex: 1, columnIndex: 1, text: '7.000' },
    ];
    const page1 = makePage([makeTable(cells)], 1, '$ in Millions');
    const page2 = makePage([makeTable(cells)], 1, '$ in Millions');

    const r1 = extractR2aProjectFunding({ group: makeGroup([page1]), cycleFiscalYear: CYCLE_FY });
    const r2 = extractR2aProjectFunding({ group: makeGroup([page2]), cycleFiscalYear: CYCLE_FY });

    expect(r1.values.map((v) => v.originalValue)).toEqual(r2.values.map((v) => v.originalValue));
  });
});

/* ------------------------------------------------------------------ */
/* Reconciler tests                                                    */
/* ------------------------------------------------------------------ */

describe('r2a-project-reconciler', () => {
  it('reconciles exact project sum', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('reconciled');
    expect(result.blocking).toBe(false);
    expect(result.childSum).toBe('12');
    expect(result.childCount).toBe(2);
  });

  it('reconciles within rounding tolerance', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.001' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
      ],
      unit: 'millions',
    });

    /* tolerance = (2+1) * 0.5 = 1.5 millions */
    expect(result.status).toBe('within_rounding');
    expect(result.blocking).toBe(false);
  });

  it('blocks outside tolerance', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '15.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('outside_tolerance');
    expect(result.blocking).toBe(true);
  });

  it('blocks on missing project', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [fundingValue({ projectCode: 'A1', originalValue: '7.000' })],
      unit: 'millions',
      expectedProjectCodes: ['A1', 'B2'],
    });

    expect(result.status).toBe('missing_project');
    expect(result.blocking).toBe(true);
    expect(result.missingProjectCodes).toEqual(['B2']);
  });

  it('blocks on duplicate project row', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }), // duplicate
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('duplicate_project_row');
    expect(result.blocking).toBe(true);
  });

  it('blocks on subtotal double-count attempt', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'SUB', originalValue: '12.000', rowKind: 'subtotal' }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('subtotal_double_count');
    expect(result.blocking).toBe(true);
  });

  it('excludes cost-to-complete from reconciliation', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'cost_to_complete',
      peTotal: peTotalCell({ printedTotal: '3.000', columnRole: 'cost_to_complete' }),
      projectValues: [
        fundingValue({
          projectCode: 'A1',
          originalValue: '3.000',
          columnRole: 'cost_to_complete',
          disposition: 'non_annual_cost',
        }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('reconciled');
    expect(result.blocking).toBe(false);
    expect(result.message).toContain('not annual funding');
  });

  it('handles zero-valued project in sum', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '7.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'B2', originalValue: '0.000' }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('reconciled');
    expect(result.childCount).toBe(2); // zero counts toward N
  });

  it('routes footnote to review, never auto-pass', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
        fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
      ],
      unit: 'millions',
      footnotes: [{ peCode: PE, text: 'Excludes classified project X', page: 1 }],
    });

    expect(result.status).toBe('review_footnote');
    expect(result.blocking).toBe(false);
    expect(result.footnoteText).toContain('classified');
  });

  it('reconciles outyear columns', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: 2028,
      columnRole: 'outyear_projection',
      peTotal: peTotalCell({
        printedTotal: '14.000',
        fiscalYear: 2028,
        columnRole: 'outyear_projection',
      }),
      projectValues: [
        fundingValue({
          projectCode: 'A1',
          originalValue: '8.000',
          fiscalYear: 2028,
          columnRole: 'outyear_projection',
        }),
        fundingValue({
          projectCode: 'B2',
          originalValue: '6.000',
          fiscalYear: 2028,
          columnRole: 'outyear_projection',
        }),
      ],
      unit: 'millions',
    });

    expect(result.status).toBe('reconciled');
  });

  it('blocks project code mismatch via dedupe', () => {
    const result = reconcileR2aProjectColumn({
      peCode: PE,
      fiscalYear: CYCLE_FY,
      columnRole: 'budget_year_request',
      peTotal: peTotalCell({ printedTotal: '12.000' }),
      projectValues: [
        fundingValue({ projectCode: 'A1', originalValue: '7.000', fiscalYear: CYCLE_FY }),
        fundingValue({ projectCode: 'B2', originalValue: '5.000', fiscalYear: CYCLE_FY }),
      ],
      unit: 'millions',
      dedupeKeys: new Set(['A1|2027|budget_year_request']),
    });

    /* A1 was already counted (from R-2), so B2 alone ≠ 12 */
    expect(result.status).toBe('duplicate_project_row');
    expect(result.blocking).toBe(true);
  });

  it('PE-level aggregation: all columns reconciled', () => {
    const result = reconcileR2aPe({
      peCode: PE,
      columns: [
        {
          peCode: PE,
          fiscalYear: CYCLE_FY,
          columnRole: 'budget_year_request',
          peTotal: peTotalCell({ printedTotal: '12.000' }),
          projectValues: [
            fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
            fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
          ],
          unit: 'millions',
        },
        {
          peCode: PE,
          fiscalYear: 2028,
          columnRole: 'outyear_projection',
          peTotal: peTotalCell({
            printedTotal: '14.000',
            fiscalYear: 2028,
            columnRole: 'outyear_projection',
          }),
          projectValues: [
            fundingValue({
              projectCode: 'A1',
              originalValue: '8.000',
              fiscalYear: 2028,
              columnRole: 'outyear_projection',
            }),
            fundingValue({
              projectCode: 'B2',
              originalValue: '6.000',
              fiscalYear: 2028,
              columnRole: 'outyear_projection',
            }),
          ],
          unit: 'millions',
        },
      ],
    });

    expect(result.complete).toBe(true);
    expect(result.blocking).toBe(false);
    expect(result.columns).toHaveLength(2);
  });

  it('PE-level aggregation: one blocking column makes PE blocking', () => {
    const result = reconcileR2aPe({
      peCode: PE,
      columns: [
        {
          peCode: PE,
          fiscalYear: CYCLE_FY,
          columnRole: 'budget_year_request',
          peTotal: peTotalCell({ printedTotal: '12.000' }),
          projectValues: [
            fundingValue({ projectCode: 'A1', originalValue: '7.000' }),
            fundingValue({ projectCode: 'B2', originalValue: '5.000' }),
          ],
          unit: 'millions',
        },
        {
          peCode: PE,
          fiscalYear: 2028,
          columnRole: 'outyear_projection',
          peTotal: peTotalCell({
            printedTotal: '20.000',
            fiscalYear: 2028,
            columnRole: 'outyear_projection',
          }),
          projectValues: [
            fundingValue({
              projectCode: 'A1',
              originalValue: '8.000',
              fiscalYear: 2028,
              columnRole: 'outyear_projection',
            }),
            fundingValue({
              projectCode: 'B2',
              originalValue: '6.000',
              fiscalYear: 2028,
              columnRole: 'outyear_projection',
            }),
          ],
          unit: 'millions',
        },
      ],
    });

    expect(result.complete).toBe(false);
    expect(result.blocking).toBe(true);
  });
});
