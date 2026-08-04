/**
 * Phase 5 Workstream C tests — P-1 master extraction.
 *
 * Representative fixtures for:
 *   - Army long BLIN;
 *   - Navy short line with appropriation namespace;
 *   - Air Force alphanumeric line;
 *   - Advance procurement;
 *   - Multiple FY columns;
 *   - Repeated header;
 *   - Wrapped title;
 *   - Ambiguous header;
 *   - Negative/parenthesized value;
 *   - Blank and dash values.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractP1FromPages } from './p1-extractor-v1.js';
import { buildP1Artifact } from './p1-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';

const CYCLE_FY = 2027;
const SHA = 'e'.repeat(64);
const ACCOUNT = '2031A: Aircraft Procurement, Army';
const COMPONENT = 'ARMY' as const;

function makeCell(
  rowIndex: number,
  columnIndex: number,
  text: string,
): ParsedTableCellV1 {
  return { rowIndex, columnIndex, text };
}

function makeTable(cells: ParsedTableCellV1[]): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return {
    tableIndex: 0,
    rowCount,
    columnCount,
    cells,
    warnings: [],
  };
}

function makePage(
  tables: ParsedTableV1[],
  text?: string,
  page = 1,
): ParserPageResultV1 {
  return {
    page,
    text,
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function makeSource(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'p1_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/p1.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement',
    exhibit: 'P-1',
    authority: 'dod-comptroller',
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

describe('p1-extractor-v1', () => {
  it('extracts an Army long BLIN with FYDP columns', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 3, 'FY 2026 Enacted ($ in Millions)'),
      makeCell(0, 4, 'FY 2027 Request ($ in Millions)'),
      makeCell(0, 5, 'FY 2028 ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '4,211.987'),
      makeCell(1, 3, '0'),
      makeCell(1, 4, '240.000'),
      makeCell(1, 5, '250.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], 'Procurement, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedCode).toBe('9670A00005');
    expect(result.identities[0]?.title).toBe('MQ-1 UAV');
    expect(result.identities[0]?.advanceProcurement).toBe(false);
    expect(result.funding).toHaveLength(4);
    expect(result.unitResolution.unit).toBe('millions');
    // Verify exact scaling: 4211.987 millions stays 4211.987
    expect(result.funding[0]?.originalValue).toBe('4211.987');
    expect(result.funding[0]?.valueMillions).toBe('4211.987');
    expect(result.funding[2]?.valueMillions).toBe('240');
  });

  it('extracts a Navy short line with appropriation namespace', () => {
    const table = makeTable([
      makeCell(0, 0, 'Line'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '0145'),
      makeCell(1, 1, 'FA-18E/F'),
      makeCell(1, 2, '5,200.5'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '1506N: Aircraft Procurement, Navy ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: '1506N: Aircraft Procurement, Navy',
      component: 'NAVY' as const,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedCode).toBe('0145');
    expect(result.identities[0]?.identity.component).toBe('NAVY');
    // Same code under different account should produce different natural key
    const result2 = extractP1FromPages({
      pages: [makePage([table], '1706N: Other Procurement, Navy ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: '1706N: Other Procurement, Navy',
      component: 'NAVY' as const,
    });
    expect(result.identities[0]?.identity.naturalKey).not.toBe(
      result2.identities[0]?.identity.naturalKey,
    );
  });

  it('extracts an Air Force alphanumeric line', () => {
    const table = makeTable([
      makeCell(0, 0, 'Line'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'B02100'),
      makeCell(1, 1, 'B-21 Raider'),
      makeCell(1, 2, '5,000.0'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '3010F: Aircraft Procurement, AF ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: '3010F: Aircraft Procurement, AF',
      component: 'AF' as const,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedCode).toBe('B02100');
  });

  it('distinguishes advance procurement from base', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '240.000'),
      makeCell(2, 0, '9670A00005'),
      makeCell(2, 1, 'MQ-1 UAV AP'),
      makeCell(2, 2, '50.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], 'Aircraft Procurement, Army ($ in Millions)\nAdvance Procurement')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    // Both rows should be extracted; one should be advance, one base
    expect(result.identities).toHaveLength(2);
    const baseId = result.identities.find((i) => !i.advanceProcurement);
    const advanceId = result.identities.find((i) => i.advanceProcurement);
    expect(baseId).toBeDefined();
    expect(advanceId).toBeDefined();
    expect(baseId?.identity.naturalKey).not.toBe(advanceId?.identity.naturalKey);
  });

  it('handles multiple FY columns with base/OCO/total split', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 ($ in Millions)'),
      makeCell(0, 3, 'FY 2026 ($ in Millions)'),
      makeCell(0, 4, 'FY 2027 Base ($ in Millions)'),
      makeCell(0, 5, 'FY 2027 OCO ($ in Millions)'),
      makeCell(0, 6, 'FY 2027 Total ($ in Millions)'),
      makeCell(0, 7, 'FY 2028 ($ in Millions)'),
      makeCell(1, 0, '6771AA0005'),
      makeCell(1, 1, 'UH-60 Blackhawk'),
      makeCell(1, 2, '100.0'),
      makeCell(1, 3, '200.0'),
      makeCell(1, 4, '300.0'),
      makeCell(1, 5, '50.0'),
      makeCell(1, 6, '350.0'),
      makeCell(1, 7, '400.0'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(6);
    // Check base/OCO/total binding
    const baseFunding = result.funding.find(
      (f) => f.columnBinding.baseOcoStatus === 'base',
    );
    const ocoFunding = result.funding.find(
      (f) => f.columnBinding.baseOcoStatus === 'oco',
    );
    const totalFunding = result.funding.find(
      (f) => f.columnBinding.baseOcoStatus === 'total',
    );
    expect(baseFunding?.valueMillions).toBe('300');
    expect(ocoFunding?.valueMillions).toBe('50');
    expect(totalFunding?.valueMillions).toBe('350');
  });

  it('handles repeated headers on continuation pages', () => {
    const header = [
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
    ];
    const page1Table = makeTable([
      ...header,
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '240.000'),
    ]);
    const page2Table = makeTable([
      ...header,
      makeCell(1, 0, '6771AA0005'),
      makeCell(1, 1, 'UH-60'),
      makeCell(1, 2, '300.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([page1Table], '($ in Millions)', 1), makePage([page2Table], '($ in Millions)', 2)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(2);
  });

  it('handles wrapped title across cells', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1C Gray Eagle'),
      makeCell(1, 2, 'Extended Range'),
      makeCell(1, 3, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.title).toContain('MQ-1C Gray Eagle');
  });

  it('emits unresolved result for ambiguous header (no FY columns)', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'Some Column'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    // The "Some Column" header cannot be classified → unresolved
    expect(result.headerBinding.hasAmbiguousColumns).toBe(true);
    expect(result.headerBinding.unresolvedColumnIndices.length).toBeGreaterThan(0);
  });

  it('handles negative/parenthesized values', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '(50.000)'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.originalValue).toBe('-50');
  });

  it('handles blank and dash values', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '-'),
      makeCell(1, 3, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    // Only one funding value (the 240.000), not the dash
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.valueMillions).toBe('240');
  });

  it('produces a contract-valid V1 artifact', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildP1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    // Should be schema-valid and semantically valid
    expect(() =>
      parseDefenseBudgetExtractionArtifactV1(artifact),
    ).not.toThrow();
    expect(artifact.summary.assertionCount).toBeGreaterThan(0);
    // All identities are PROCUREMENT_BLIN, never RDTE_PE
    const procLines = artifact.assertions.filter(
      (a) => a.assertionKind === 'procurement_line',
    );
    expect(procLines.length).toBeGreaterThan(0);
    for (const a of procLines) {
      expect(a.parentIdentity.lineKind).toBe('PROCUREMENT_BLIN');
    }
  });

  it('P-1 request money is not mistaken for enacted data', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '4,211.987'),
      makeCell(1, 3, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const requestVal = result.funding.find(
      (f) => f.columnBinding.fundingStage === 'budget_year_request',
    );
    const actualVal = result.funding.find(
      (f) => f.columnBinding.fundingStage === 'prior_actual',
    );
    expect(requestVal?.valueMillions).toBe('240');
    expect(actualVal?.valueMillions).toBe('4211.987');
    expect(requestVal?.columnBinding.fundingStage).not.toBe(actualVal?.columnBinding.fundingStage);
  });

  it('does not use positional fallback for FY binding', () => {
    const table = makeTable([
      makeCell(0, 0, 'BLIN'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '9670A00005'),
      makeCell(1, 1, 'MQ-1 UAV'),
      makeCell(1, 2, '240.000'),
    ]);
    const result = extractP1FromPages({
      pages: [makePage([table], '($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.usedPositionalFallback).toBe(false);
    // All bindings should be confident (from header text)
    expect(result.headerBinding.unresolvedColumnIndices).toHaveLength(0);
  });
});
