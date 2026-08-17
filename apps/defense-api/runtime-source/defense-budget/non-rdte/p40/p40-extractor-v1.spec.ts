/**
 * Phase 5 Workstream D tests — P-40 extraction.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractP40FromPages } from './p40-extractor-v1.js';
import { buildP40Artifact } from './p40-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';

const CYCLE_FY = 2027;
const SHA = 'f'.repeat(64);
const ACCOUNT = '2031A: Aircraft Procurement, Army';
const COMPONENT = 'ARMY' as const;

function makeCell(rowIndex: number, columnIndex: number, text: string): ParsedTableCellV1 {
  return { rowIndex, columnIndex, text };
}
function makeTable(cells: ParsedTableCellV1[], label?: string): ParsedTableV1 {
  const rowCount = Math.max(...cells.map((c) => c.rowIndex)) + 1;
  const columnCount = Math.max(...cells.map((c) => c.columnIndex)) + 1;
  return {
    tableIndex: 0,
    rowCount,
    columnCount,
    cells,
    ...(label != null ? { label } : {}),
    warnings: [],
  };
}
function makePage(tables: ParsedTableV1[], text?: string, page = 1): ParserPageResultV1 {
  return {
    page,
    text,
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only' as const,
    warnings: [],
  };
}
function makeSource(): ExtractionSourceV1 {
  return {
    manifestDocumentKey: 'p40_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/p40.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement' as const,
    exhibit: 'P-40' as const,
    authority: 'dod-comptroller' as const,
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

const P40_HEADER = '9670A00005 / MQ-1 UAV\n2031A: Aircraft Procurement, Army / BA 01: Aircraft';

describe('p40-extractor-v1', () => {
  it('extracts P-40 parent identity and resource summary', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2025 ($ in Millions)'),
      makeCell(0, 2, 'FY 2027 Base ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Total ($ in Millions)'),
      makeCell(1, 0, 'Procurement Quantity'),
      makeCell(1, 1, '0'),
      makeCell(1, 2, '-'),
      makeCell(1, 3, '-'),
      makeCell(2, 0, 'Net Procurement (P-1)'),
      makeCell(2, 1, '4,211.987'),
      makeCell(2, 2, '200.000'),
      makeCell(2, 3, '240.000'),
      makeCell(3, 0, 'Gross/Weapon System Unit Cost'),
      makeCell(3, 1, '13,080.705'),
      makeCell(3, 2, '-'),
      makeCell(3, 3, '-'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentIdentity).not.toBeNull();
    expect(result.parentIdentity?.printedCode).toBe('9670A00005');
    expect(result.parentIdentity?.title).toBe('MQ-1 UAV');
    expect(result.parentIdentity?.budgetActivity).toBe('BA 01');
    expect(result.resourceSummary.length).toBeGreaterThan(0);
  });

  it('handles base/OOC/total split', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 Base ($ in Millions)'),
      makeCell(0, 2, 'FY 2027 OOC ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Total ($ in Millions)'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '200.000'),
      makeCell(1, 2, '40.000'),
      makeCell(1, 3, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const baseVal = result.resourceSummary.find((v) => v.columnBinding.baseOcoStatus === 'base');
    const oocVal = result.resourceSummary.find((v) => v.columnBinding.baseOcoStatus === 'ooc');
    const totalVal = result.resourceSummary.find((v) => v.columnBinding.baseOcoStatus === 'total');
    expect(baseVal?.valueMillions).toBe('200');
    expect(oocVal?.valueMillions).toBe('40');
    expect(totalVal?.valueMillions).toBe('240');
  });

  it('handles advance procurement line', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '50.000'),
    ]);
    const result = extractP40FromPages({
      pages: [
        makePage(
          [table],
          '9670A00005 / MQ-1 UAV AP\nAdvance Procurement\n2031A: Aircraft Procurement, Army',
        ),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentIdentity?.advanceProcurement).toBe(true);
  });

  it('extracts secondary distribution with multiple recipients', () => {
    const distTable = makeTable([
      makeCell(0, 0, 'Secondary Distribution'),
      makeCell(0, 1, 'FY 2027 Quantity'),
      makeCell(0, 2, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Army - Active'),
      makeCell(1, 1, '5'),
      makeCell(1, 2, '100.000'),
      makeCell(2, 0, 'Army - Reserve'),
      makeCell(2, 1, '3'),
      makeCell(2, 2, '60.000'),
      makeCell(3, 0, 'Navy'),
      makeCell(3, 1, '0'),
      makeCell(3, 2, '80.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([distTable], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.secondaryDistribution.length).toBeGreaterThanOrEqual(3);
    const recipients = result.secondaryDistribution.map((d) => d.recipient);
    expect(recipients).toContain('Army - Active');
    expect(recipients).toContain('Army - Reserve');
    expect(recipients).toContain('Navy');
  });

  it('explicit PE reference becomes relationship, not identity', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [
        makePage(
          [table],
          '9670A00005 / MQ-1 UAV\nPE 0602308A referenced\n2031A: Aircraft Procurement, Army',
        ),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentIdentity?.referencedPeCodes).toContain('0602308A');
    expect(result.parentIdentity?.identity.lineKind).toBe('PROCUREMENT_BLIN');
  });

  it('quantity and money remain distinct', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 Quantity'),
      makeCell(0, 2, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Procurement Quantity'),
      makeCell(1, 1, '8'),
      makeCell(1, 2, '-'),
      makeCell(2, 0, 'Net Procurement (P-1)'),
      makeCell(2, 1, '-'),
      makeCell(2, 2, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const qtyVals = result.resourceSummary.filter((v) => /quantity/i.test(v.rowLabel));
    const moneyVals = result.resourceSummary.filter((v) => /net procurement/i.test(v.rowLabel));
    expect(qtyVals.length).toBeGreaterThan(0);
    expect(moneyVals.length).toBeGreaterThan(0);
    expect(qtyVals[0]?.originalValue).toBe('8');
    expect(moneyVals[0]?.originalValue).toBe('240');
  });

  it('unit cost in thousands converts exactly', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 ($ in Thousands)'),
      makeCell(1, 0, 'Gross/Weapon System Unit Cost'),
      makeCell(1, 1, '30,000.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const unitCostVal = result.resourceSummary.find((v) => /gross|unit/i.test(v.rowLabel));
    expect(unitCostVal?.originalUnit).toBe('thousands');
    expect(unitCostVal?.originalValue).toBe('30000');
    expect(unitCostVal?.valueMillions).toBe('30');
  });

  it('missing printed unit becomes omission', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.omissions.some((o) => o.reason.includes('unit'))).toBe(true);
  });

  it('produces a contract-valid V1 artifact', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildP40Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(() => parseDefenseBudgetExtractionArtifactV1(artifact)).not.toThrow();
    expect(artifact.summary.assertionCount).toBeGreaterThan(0);
    const procLines = artifact.assertions.filter((a) => a.assertionKind === 'procurement_line');
    expect(procLines.length).toBeGreaterThan(0);
    for (const a of procLines) {
      expect(a.parentIdentity.lineKind).toBe('PROCUREMENT_BLIN');
    }
  });

  it('PE reference in artifact is a relationship, not RDTE_PE identity', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [
        makePage(
          [table],
          '9670A00005 / MQ-1 UAV\nPE 0602308A referenced\n2031A: Aircraft Procurement, Army',
        ),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildP40Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const relationships = artifact.assertions.filter((a) => a.assertionKind === 'relationship');
    expect(relationships.length).toBeGreaterThan(0);
    for (const r of relationships) {
      if (r.assertionKind === 'relationship') {
        expect(r.from.lineKind).toBe('PROCUREMENT_BLIN');
        expect(r.to.lineKind).toBe('RDTE_PE');
        expect(r.relationshipType).toBe('references');
      }
    }
    const peIdentities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(peIdentities).toHaveLength(0);
  });

  it('arithmetic check is not universally enforced', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027 Quantity'),
      makeCell(0, 2, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Procurement Quantity'),
      makeCell(1, 1, '8'),
      makeCell(1, 2, '-'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.arithmeticCheckApplicable).toBe(false);
  });

  it('does not infer unit by magnitude', () => {
    const table = makeTable([
      makeCell(0, 0, 'Resource Summary'),
      makeCell(0, 1, 'FY 2027'),
      makeCell(1, 0, 'Net Procurement (P-1)'),
      makeCell(1, 1, '240.000'),
    ]);
    const result = extractP40FromPages({
      pages: [makePage([table], P40_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.unitResolution.unit).toBeUndefined();
    expect(result.omissions.some((o) => o.reason.includes('unit'))).toBe(true);
  });
});
