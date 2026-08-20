/**
 * Phase 6 Workstream C — congressional table semantics tests.
 *
 * Required coverage: standard request/change/total table, total-only table,
 * change-only row with and without a baseline, multiple numeric narrative
 * tokens, duplicate equal rows, duplicate conflicting rows, transfer and
 * rescission signs, quantity columns not treated as money, a table with no
 * declared unit, and a row carrying only page-level evidence.
 */
import {
  CONGRESSIONAL_TABLE_SCHEMA_VERSION,
  composeDuplicateRowsV1,
  congressionalTableV1Schema,
  deriveAbsolutePositionV1,
  rowMoneyV1,
  rowQuantitiesV1,
  sumRowValuesV1,
  type CongressionalColumnV1,
  type CongressionalRowV1,
  type CongressionalTableV1,
} from './congressional-table-v1.js';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

const PE = '1160402F';

function column(overrides: Partial<CongressionalColumnV1> & { columnIndex: number }) {
  return {
    headerText: `col-${overrides.columnIndex}`,
    isQuantity: false,
    ...overrides,
  } as CongressionalColumnV1;
}

function peRow(overrides: Partial<CongressionalRowV1> & { rowIndex: number }): CongressionalRowV1 {
  return {
    rawLabel: `PE ${PE} Advanced Technology`,
    reference: { referenceKind: 'pe_code', peCode: PE },
    semanticKind: 'absolute_position',
    cells: [],
    ...overrides,
  } as CongressionalRowV1;
}

function table(overrides: Partial<CongressionalTableV1> = {}): CongressionalTableV1 {
  return {
    schemaVersion: CONGRESSIONAL_TABLE_SCHEMA_VERSION,
    profileId: 'fy2026-hasc-rdte',
    sourceDocumentId: 'hasc-report-fy2026',
    sourceSha256: 'a'.repeat(64),
    page: 42,
    printedPage: 'II-14',
    headings: ['TITLE II — RESEARCH, DEVELOPMENT, TEST AND EVALUATION'],
    declaredUnit: 'thousands',
    columns: [],
    rows: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* contract                                                            */
/* ------------------------------------------------------------------ */

describe('congressional table — contract', () => {
  it('accepts a well-formed table and rejects unknown keys', () => {
    const value = table({
      columns: [column({ columnIndex: 0, headerText: 'Line' })],
      rows: [peRow({ rowIndex: 0 })],
    });
    expect(congressionalTableV1Schema.parse(value)).toEqual(value);
    expect(() => congressionalTableV1Schema.parse({ ...value, mysteryField: true })).toThrow();
  });

  it('requires a physical page, so page-level evidence always exists', () => {
    const { page: _dropped, ...withoutPage } = table();
    expect(() => congressionalTableV1Schema.parse(withoutPage)).toThrow();
  });

  it('accepts a row whose only evidence is the table page (truthful page-only)', () => {
    const value = table({
      columns: [
        column({
          columnIndex: 1,
          headerText: 'FY26 Request',
          moneySemantic: 'request_baseline',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [{ rowIndex: 0, columnIndex: 1, rawText: '100', value: '100' }],
        }),
      ],
    });
    const parsed = congressionalTableV1Schema.parse(value);
    expect(parsed.rows[0]!.cells[0]!.boundingBox).toBeUndefined();
    expect(parsed.page).toBe(42);
  });
});

/* ------------------------------------------------------------------ */
/* header-driven semantics                                             */
/* ------------------------------------------------------------------ */

describe('congressional table — header-driven money semantics', () => {
  const standard = table({
    columns: [
      column({ columnIndex: 0, headerText: 'Program Element' }),
      column({
        columnIndex: 1,
        headerText: 'FY26 Request',
        moneySemantic: 'request_baseline',
        fiscalYear: 2026,
      }),
      column({ columnIndex: 2, headerText: 'Change', moneySemantic: 'change', fiscalYear: 2026 }),
      column({
        columnIndex: 3,
        headerText: 'HASC Recommended',
        moneySemantic: 'recommended_total',
        fiscalYear: 2026,
      }),
    ],
    rows: [
      peRow({
        rowIndex: 0,
        cells: [
          { rowIndex: 0, columnIndex: 0, rawText: `PE ${PE}` },
          { rowIndex: 0, columnIndex: 1, rawText: '100', value: '100' },
          { rowIndex: 0, columnIndex: 2, rawText: '25', value: '25' },
          { rowIndex: 0, columnIndex: 3, rawText: '125', value: '125' },
        ],
      }),
    ],
  });

  it('reads request/change/total by header, not by position', () => {
    const money = rowMoneyV1(standard, standard.rows[0]!);
    expect(money.map((entry) => entry.semantic)).toEqual([
      'request_baseline',
      'change',
      'recommended_total',
    ]);
    // The last numeric token happens to be the total here, but the mapping is
    // by header: reversing the columns must not change the semantics.
    const reversed = { ...standard, columns: [...standard.columns].reverse() };
    const reversedMoney = rowMoneyV1(reversed, reversed.rows[0]!);
    expect(new Set(reversedMoney.map((entry) => entry.semantic))).toEqual(
      new Set(['request_baseline', 'change', 'recommended_total']),
    );
  });

  it('uses the printed total directly and marks it direct, not derived', () => {
    const derivation = deriveAbsolutePositionV1(standard, standard.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation.status).toBe('direct');
    if (derivation.status !== 'direct') throw new Error('expected direct');
    expect(derivation.value).toBe('125');
    expect(derivation.semantic).toBe('recommended_total');
  });

  it('total-only table still yields the position', () => {
    const totalOnly = table({
      columns: [
        column({ columnIndex: 0, headerText: 'Program Element' }),
        column({
          columnIndex: 1,
          headerText: 'Authorized',
          moneySemantic: 'authorized_total',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [
            { rowIndex: 0, columnIndex: 0, rawText: `PE ${PE}` },
            { rowIndex: 0, columnIndex: 1, rawText: '90', value: '90' },
          ],
        }),
      ],
    });
    const derivation = deriveAbsolutePositionV1(totalOnly, totalOnly.rows[0]!, {
      allowBaselinePlusChange: false,
    });
    expect(derivation.status).toBe('direct');
  });

  it('ignores extra numeric tokens in a narrative-only row', () => {
    const narrative = table({
      columns: [column({ columnIndex: 0, headerText: 'Item' })],
      rows: [
        peRow({
          rowIndex: 0,
          semanticKind: 'narrative_only',
          rawLabel: 'The committee notes 3 prototypes and 12 months of testing',
          cells: [
            {
              rowIndex: 0,
              columnIndex: 0,
              rawText: 'The committee notes 3 prototypes and 12 months of testing',
            },
          ],
          finding: 'narrative row carries no funding column',
        }),
      ],
    });
    expect(rowMoneyV1(narrative, narrative.rows[0]!)).toEqual([]);
    expect(
      deriveAbsolutePositionV1(narrative, narrative.rows[0]!, { allowBaselinePlusChange: true })
        .status,
    ).toBe('blocked');
  });
});

/* ------------------------------------------------------------------ */
/* change -> absolute derivation                                       */
/* ------------------------------------------------------------------ */

describe('congressional table — change-only rows', () => {
  function changeOnly(withBaseline: boolean): CongressionalTableV1 {
    const columns = [
      column({ columnIndex: 0, headerText: 'Program Element' }),
      column({ columnIndex: 2, headerText: 'Change', moneySemantic: 'change', fiscalYear: 2026 }),
    ];
    const cells = [
      { rowIndex: 0, columnIndex: 0, rawText: `PE ${PE}` },
      { rowIndex: 0, columnIndex: 2, rawText: '25', value: '25' },
    ];
    if (withBaseline) {
      columns.splice(
        1,
        0,
        column({
          columnIndex: 1,
          headerText: 'FY26 Request',
          moneySemantic: 'request_baseline',
          fiscalYear: 2026,
        }),
      );
      cells.splice(1, 0, { rowIndex: 0, columnIndex: 1, rawText: '100', value: '100' });
    }
    return table({ columns, rows: [peRow({ rowIndex: 0, cells })] });
  }

  it('derives an absolute total from an exact baseline plus change when policy allows', () => {
    const value = changeOnly(true);
    const derivation = deriveAbsolutePositionV1(value, value.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation.status).toBe('derived');
    if (derivation.status !== 'derived') throw new Error('expected derived');
    expect(derivation.value).toBe('125');
    expect(derivation.baseline).toBe('100');
    expect(derivation.change).toBe('25');
  });

  it('blocks derivation when policy forbids it, even with a valid baseline', () => {
    const value = changeOnly(true);
    const derivation = deriveAbsolutePositionV1(value, value.rows[0]!, {
      allowBaselinePlusChange: false,
    });
    expect(derivation).toEqual({ status: 'blocked', reason: 'policy_forbids_derivation' });
  });

  it('blocks derivation with no baseline', () => {
    const value = changeOnly(false);
    const derivation = deriveAbsolutePositionV1(value, value.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation).toEqual({ status: 'blocked', reason: 'no_baseline' });
  });

  it('blocks derivation when baseline and change fiscal years differ', () => {
    const value = changeOnly(true);
    const shifted: CongressionalTableV1 = {
      ...value,
      columns: value.columns.map((entry) =>
        entry.moneySemantic === 'change' ? { ...entry, fiscalYear: 2027 } : entry,
      ),
    };
    const derivation = deriveAbsolutePositionV1(shifted, shifted.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation).toEqual({ status: 'blocked', reason: 'fiscal_year_mismatch' });
  });

  it('blocks derivation when units differ', () => {
    const value = changeOnly(true);
    const mixed: CongressionalTableV1 = {
      ...value,
      columns: value.columns.map((entry) =>
        entry.moneySemantic === 'change' ? { ...entry, declaredUnit: 'millions' } : entry,
      ),
    };
    const derivation = deriveAbsolutePositionV1(mixed, mixed.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation).toEqual({ status: 'blocked', reason: 'unit_mismatch' });
  });

  it('never turns an adjustment row into an absolute position', () => {
    const value = changeOnly(true);
    const adjustment: CongressionalTableV1 = {
      ...value,
      rows: [{ ...value.rows[0]!, semanticKind: 'adjustment' }],
    };
    const derivation = deriveAbsolutePositionV1(adjustment, adjustment.rows[0]!, {
      allowBaselinePlusChange: true,
    });
    expect(derivation).toEqual({ status: 'blocked', reason: 'row_is_not_position_bearing' });
  });
});

/* ------------------------------------------------------------------ */
/* transfers and rescissions                                           */
/* ------------------------------------------------------------------ */

describe('congressional table — transfers and rescissions', () => {
  it('preserves transfer and rescission signs and never treats them as totals', () => {
    const value = table({
      columns: [
        column({ columnIndex: 0, headerText: 'Line' }),
        column({
          columnIndex: 1,
          headerText: 'Transfer',
          moneySemantic: 'transfer_amount',
          fiscalYear: 2026,
        }),
        column({
          columnIndex: 2,
          headerText: 'Rescission',
          moneySemantic: 'rescission_amount',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          semanticKind: 'transfer_out',
          cells: [
            { rowIndex: 0, columnIndex: 0, rawText: `PE ${PE}` },
            { rowIndex: 0, columnIndex: 1, rawText: '(15.000)', value: '-15' },
          ],
        }),
        peRow({
          rowIndex: 1,
          semanticKind: 'rescission',
          cells: [
            { rowIndex: 1, columnIndex: 0, rawText: `PE ${PE}` },
            { rowIndex: 1, columnIndex: 2, rawText: '(4.500)', value: '-4.5' },
          ],
        }),
      ],
    });
    const transfer = rowMoneyV1(value, value.rows[0]!);
    expect(transfer[0]!.value).toBe('-15');
    const rescission = rowMoneyV1(value, value.rows[1]!);
    expect(rescission[0]!.value).toBe('-4.5');
    for (const row of value.rows) {
      expect(deriveAbsolutePositionV1(value, row, { allowBaselinePlusChange: true }).status).toBe(
        'blocked',
      );
    }
  });

  it('sums same-unit values exactly, without floating point', () => {
    expect(sumRowValuesV1(['0.1', '0.2'])).toBe('0.3');
  });
});

/* ------------------------------------------------------------------ */
/* quantities and missing units                                        */
/* ------------------------------------------------------------------ */

describe('congressional table — quantities and units', () => {
  it('never reads a quantity column as money', () => {
    const value = table({
      columns: [
        column({ columnIndex: 0, headerText: 'Line' }),
        column({ columnIndex: 1, headerText: 'Qty', isQuantity: true, fiscalYear: 2026 }),
        column({
          columnIndex: 2,
          headerText: 'Authorized',
          moneySemantic: 'authorized_total',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [
            { rowIndex: 0, columnIndex: 0, rawText: `PE ${PE}` },
            { rowIndex: 0, columnIndex: 1, rawText: '4', value: '4' },
            { rowIndex: 0, columnIndex: 2, rawText: '90', value: '90' },
          ],
        }),
      ],
    });
    expect(rowMoneyV1(value, value.rows[0]!).map((entry) => entry.value)).toEqual(['90']);
    expect(rowQuantitiesV1(value, value.rows[0]!).map((entry) => entry.value)).toEqual(['4']);
  });

  it('yields no money when the table declares no unit', () => {
    const value = table({
      declaredUnit: undefined,
      columns: [
        column({
          columnIndex: 1,
          headerText: 'Authorized',
          moneySemantic: 'authorized_total',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [{ rowIndex: 0, columnIndex: 1, rawText: '90', value: '90' }],
        }),
      ],
    });
    expect(rowMoneyV1(value, value.rows[0]!)).toEqual([]);
  });

  it('does not coerce a blank or dash cell to zero', () => {
    const value = table({
      columns: [
        column({
          columnIndex: 1,
          headerText: 'Authorized',
          moneySemantic: 'authorized_total',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [{ rowIndex: 0, columnIndex: 1, rawText: '—' }],
        }),
      ],
    });
    expect(rowMoneyV1(value, value.rows[0]!)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* duplicate-safe composition                                          */
/* ------------------------------------------------------------------ */

describe('congressional table — duplicate-safe composition', () => {
  function twoRows(secondValue: string): CongressionalTableV1 {
    return table({
      columns: [
        column({ columnIndex: 0, headerText: 'Line' }),
        column({
          columnIndex: 1,
          headerText: 'Authorized',
          moneySemantic: 'authorized_total',
          fiscalYear: 2026,
        }),
      ],
      rows: [
        peRow({
          rowIndex: 0,
          cells: [{ rowIndex: 0, columnIndex: 1, rawText: '90', value: '90' }],
        }),
        peRow({
          rowIndex: 1,
          cells: [{ rowIndex: 1, columnIndex: 1, rawText: secondValue, value: secondValue }],
        }),
      ],
    });
  }

  it('composes duplicate rows that agree, retaining both rows', () => {
    const groups = composeDuplicateRowsV1(twoRows('90'));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[0]!.agreedValue).toBe('90');
    expect(groups[0]!.conflict).toBeUndefined();
  });

  it('reports a conflict when duplicate rows disagree, and never picks a winner', () => {
    const groups = composeDuplicateRowsV1(twoRows('95'));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(2);
    expect(groups[0]!.agreedValue).toBeUndefined();
    expect(groups[0]!.conflict).toEqual({ values: ['90', '95'] });
  });

  it('does not group a position row with an adjustment row for the same line', () => {
    const value = twoRows('90');
    const mixed: CongressionalTableV1 = {
      ...value,
      rows: [value.rows[0]!, { ...value.rows[1]!, semanticKind: 'adjustment' }],
    };
    const groups = composeDuplicateRowsV1(mixed);
    expect(groups).toHaveLength(2);
  });

  it('retains every row, including unresolved ones', () => {
    const value = table({
      columns: [column({ columnIndex: 0, headerText: 'Line' })],
      rows: [
        {
          rowIndex: 0,
          rawLabel: 'Classified programs',
          reference: { referenceKind: 'unresolved_reference', rawText: 'Classified programs' },
          semanticKind: 'unresolved',
          cells: [],
          finding: 'no resolvable native identity',
        },
      ],
    });
    const groups = composeDuplicateRowsV1(value);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows[0]!.semanticKind).toBe('unresolved');
    expect(groups[0]!.agreedValue).toBeUndefined();
  });
});
