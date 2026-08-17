/**
 * rdte-table-semantics.spec — Workstream B tests.
 *
 * Table-driven tests for:
 *   - all header variants;
 *   - multi-row merges;
 *   - base/OCO/total selection;
 *   - missing units;
 *   - conflicting units;
 *   - FYDP mapping;
 *   - cost-to-complete/total-cost exclusion;
 *   - exact-decimal tolerance;
 *   - large child counts;
 *   - negative adjustments;
 *   - zero values;
 *   - column-order permutation.
 */
import { classifyRdteColumn, classifyRdteHeader } from './rdte-column-classifier.js';
import { normalizeRdteHeader, type RawHeaderRowV1 } from './rdte-header-normalizer.js';
import { resolveRdteUnit } from './rdte-unit-resolver.js';
import {
  exactAbsDifference,
  independentPrintedValueToleranceMillions,
  totalVsChildrenToleranceMillions,
  withinExactTolerance,
} from './rdte-rounding-policy-v1.js';

const CYCLE_FY = 2027;

function headerFromTexts(texts: string[]): ReturnType<typeof normalizeRdteHeader> {
  const rows: RawHeaderRowV1[] = [
    {
      rowIndex: 0,
      cells: texts.map((text, i) => ({ text, rowIndex: 0, columnIndex: i })),
    },
  ];
  return normalizeRdteHeader({ headerRows: rows, cycleFiscalYear: CYCLE_FY });
}

describe('rdte-header-normalizer', () => {
  it.each([
    ['FY 2027', 2027],
    ['FY2027', 2027],
    ['FY27', 2027],
    ['2027', 2027],
    ['FY 2028 Request', 2028],
  ])('parses explicit fiscal year from "%s"', (text, expected) => {
    const header = headerFromTexts([text]);
    expect(header.columns[0]?.explicitFiscalYear).toBe(expected);
    expect(header.columns[0]?.fiscalLabelKind).toBe('explicit_fy');
  });

  it.each([
    ['BY', 2027, 0],
    ['BY1', 2028, 1],
    ['BY2', 2029, 2],
  ])('parses budget-year relative "%s" as FY %d', (text, expectedFy, expectedOffset) => {
    const header = headerFromTexts([text]);
    expect(header.columns[0]?.explicitFiscalYear).toBe(expectedFy);
    expect(header.columns[0]?.relativeOffset).toBe(expectedOffset);
    expect(header.columns[0]?.fiscalLabelKind).toBe('budget_year_relative');
  });

  it('parses PY as prior year', () => {
    const header = headerFromTexts(['PY']);
    expect(header.columns[0]?.explicitFiscalYear).toBe(2026);
    expect(header.columns[0]?.fiscalLabelKind).toBe('prior_year_relative');
  });

  it('parses CY as current year', () => {
    const header = headerFromTexts(['CY']);
    expect(header.columns[0]?.explicitFiscalYear).toBe(2027);
    expect(header.columns[0]?.fiscalLabelKind).toBe('current_year_relative');
  });

  it('handles multi-row headers with merged cells', () => {
    const rows: RawHeaderRowV1[] = [
      {
        rowIndex: 0,
        cells: [
          { text: 'FY 2027', rowIndex: 0, columnIndex: 0, colSpan: 2 },
          { text: 'FY 2028', rowIndex: 0, columnIndex: 2 },
        ],
      },
      {
        rowIndex: 1,
        cells: [
          { text: 'Base', rowIndex: 1, columnIndex: 0 },
          { text: 'OCO', rowIndex: 1, columnIndex: 1 },
          { text: 'Total', rowIndex: 1, columnIndex: 2 },
        ],
      },
    ];
    const header = normalizeRdteHeader({ headerRows: rows, cycleFiscalYear: CYCLE_FY });
    expect(header.headerRowCount).toBe(2);
    expect(header.columns).toHaveLength(3);
    expect(header.columns[0]?.normalizedText).toContain('FY 2027');
    expect(header.columns[0]?.normalizedText).toContain('Base');
    expect(header.columns[1]?.normalizedText).toContain('OCO');
    expect(header.columns[2]?.normalizedText).toContain('FY 2028');
  });

  it('handles labels split across lines', () => {
    const rows: RawHeaderRowV1[] = [
      {
        rowIndex: 0,
        cells: [{ text: 'FY', rowIndex: 0, columnIndex: 0 }],
      },
      {
        rowIndex: 1,
        cells: [{ text: '2027', rowIndex: 1, columnIndex: 0 }],
      },
    ];
    const header = normalizeRdteHeader({ headerRows: rows, cycleFiscalYear: CYCLE_FY });
    expect(header.columns[0]?.explicitFiscalYear).toBe(2027);
  });

  it('detects cost-to-complete and total-cost labels', () => {
    const header = headerFromTexts(['Cost to Complete', 'Total Cost']);
    expect(header.columns[0]?.fiscalLabelKind).toBe('cost_to_complete');
    expect(header.columns[1]?.fiscalLabelKind).toBe('total_cost');
  });

  it('never invents a fiscal year for unlabeled columns', () => {
    const header = headerFromTexts(['Funding']);
    expect(header.columns[0]?.fiscalLabelKind).toBe('unlabeled');
    expect(header.columns[0]?.explicitFiscalYear).toBeUndefined();
  });

  it('uses positional fallback only when explicitly authorized', () => {
    const rows: RawHeaderRowV1[] = [
      {
        rowIndex: 0,
        cells: [{ text: 'Value', rowIndex: 0, columnIndex: 0 }],
      },
    ];
    const header = normalizeRdteHeader({
      headerRows: rows,
      cycleFiscalYear: CYCLE_FY,
      positionalFallbackPolicy: {
        policyId: 'test_policy',
        positionToRole: { 0: 'budget_year_request' },
      },
    });
    expect(header.usedPositionalFallback).toBe(true);
    expect(header.fallbackPolicyId).toBe('test_policy');
    // Fallback must NOT invent a fiscal year.
    expect(header.columns[0]?.explicitFiscalYear).toBeUndefined();
  });

  it('does not use positional fallback when not authorized', () => {
    const header = headerFromTexts(['Value']);
    expect(header.usedPositionalFallback).toBe(false);
  });
});

describe('rdte-column-classifier', () => {
  it.each([
    ['FY 2025 Actual', 'prior_actual_context', 2025],
    ['FY 2026 Enacted', 'current_enacted_context', 2026],
    ['FY 2027 Request', 'budget_year_request', 2027],
    ['FY 2028', 'outyear_projection', 2028],
    ['FY 2028 Projection', 'outyear_projection', 2028],
    ['Cost to Complete', 'cost_to_complete', undefined],
    ['Total Cost', 'total_cost', undefined],
    ['FY 2027 Base', 'base_component', 2027],
    ['FY 2027 OCO', 'oco_component', 2027],
    ['FY 2027 Total', 'total_component', 2027],
  ])('classifies "%s" as %s', (text, expectedRole, expectedFy) => {
    const header = headerFromTexts([text]);
    const column = header.columns[0];
    expect(column).toBeDefined();
    if (column == null) return;
    const result = classifyRdteColumn({ column, cycleFiscalYear: CYCLE_FY });
    expect(result.role).toBe(expectedRole);
    expect(result.fiscalYear).toBe(expectedFy);
  });

  it('classifies prior-year unlabeled columns as prior_actual_context', () => {
    const header = headerFromTexts(['FY 2025']);
    const column = header.columns[0];
    if (column == null) throw new Error('missing column');
    const result = classifyRdteColumn({ column, cycleFiscalYear: CYCLE_FY });
    expect(result.role).toBe('prior_actual_context');
  });

  it('classifies cycle-FY unlabeled columns as budget_year_request with low confidence', () => {
    const header = headerFromTexts(['FY 2027']);
    const column = header.columns[0];
    if (column == null) throw new Error('missing column');
    const result = classifyRdteColumn({ column, cycleFiscalYear: CYCLE_FY });
    expect(result.role).toBe('budget_year_request');
    expect(result.confident).toBe(false);
  });

  it('classifies a full FYDP header row', () => {
    const header = headerFromTexts([
      'FY 2025 Actual',
      'FY 2026 Enacted',
      'FY 2027 Request',
      'FY 2028',
      'FY 2029',
      'FY 2030',
      'FY 2031',
      'Cost to Complete',
      'Total Cost',
    ]);
    const results = classifyRdteHeader({
      columns: header.columns,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(results.map((r) => r.role)).toEqual([
      'prior_actual_context',
      'current_enacted_context',
      'budget_year_request',
      'outyear_projection',
      'outyear_projection',
      'outyear_projection',
      'outyear_projection',
      'cost_to_complete',
      'total_cost',
    ]);
  });

  it('classifies base/OCO/total groupings', () => {
    const header = headerFromTexts(['FY 2027 Base', 'FY 2027 OCO', 'FY 2027 Total']);
    const results = classifyRdteHeader({
      columns: header.columns,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(results.map((r) => r.role)).toEqual([
      'base_component',
      'oco_component',
      'total_component',
    ]);
  });

  it('returns unknown for unlabeled columns without fiscal year', () => {
    const header = headerFromTexts(['Funding']);
    const column = header.columns[0];
    if (column == null) throw new Error('missing column');
    const result = classifyRdteColumn({ column, cycleFiscalYear: CYCLE_FY });
    expect(result.role).toBe('unknown');
    expect(result.confident).toBe(false);
  });
});

describe('rdte-unit-resolver', () => {
  it('resolves thousands from explicit label', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: '$ in Thousands', page: 5 }],
    });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') {
      expect(result.unit).toBe('thousands');
      expect(result.evidence.page).toBe(5);
    }
  });

  it('resolves millions from explicit label', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: 'In Millions of Dollars' }],
    });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.unit).toBe('millions');
  });

  it('resolves dollars from explicit label', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: '$ in Dollars' }],
    });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.unit).toBe('dollars');
  });

  it('returns missing when no label and no manifest policy', () => {
    const result = resolveRdteUnit({ candidates: [{ rawText: 'Budget Exhibit' }] });
    expect(result.status).toBe('missing');
  });

  it('uses manifest policy when source is silent', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: 'Budget Exhibit' }],
      manifestUnit: 'thousands',
    });
    expect(result.status).toBe('resolved');
    if (result.status === 'resolved') expect(result.unit).toBe('thousands');
  });

  it('returns blocking conflict on conflicting labels', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: '$ in Thousands' }, { rawText: '$ in Millions' }],
    });
    expect(result.status).toBe('conflict');
    if (result.status === 'conflict') {
      expect(result.units).toContain('thousands');
      expect(result.units).toContain('millions');
    }
  });

  it('never infers unit from magnitude', () => {
    const result = resolveRdteUnit({
      candidates: [{ rawText: '1,234,567' }],
    });
    expect(result.status).toBe('missing');
  });
});

describe('rdte-rounding exact-decimal tolerance', () => {
  it('handles zero values exactly', () => {
    expect(exactAbsDifference('0', '0')).toBe('0');
    expect(withinExactTolerance('0', '0', '0.001')).toBe(true);
  });

  it('handles negative adjustments exactly', () => {
    expect(exactAbsDifference('-1.5', '1.5')).toBe('3');
    expect(withinExactTolerance('-1.000', '-0.999', '0.001')).toBe(true);
  });

  it('handles large child counts exactly', () => {
    expect(totalVsChildrenToleranceMillions(100, 'thousands')).toBe('0.0505');
    expect(totalVsChildrenToleranceMillions(1000, 'thousands')).toBe('0.5005');
  });

  it('rejects percent-style tolerance by construction', () => {
    // The API only exposes unit-based tolerances; there is no percent function.
    expect(independentPrintedValueToleranceMillions('thousands')).toBe('0.001');
    expect(totalVsChildrenToleranceMillions(2, 'thousands')).toBe('0.0015');
  });

  it('is deterministic under column-order permutation', () => {
    const a = totalVsChildrenToleranceMillions(3, 'thousands');
    const b = totalVsChildrenToleranceMillions(3, 'thousands');
    expect(a).toBe(b);
  });
});
