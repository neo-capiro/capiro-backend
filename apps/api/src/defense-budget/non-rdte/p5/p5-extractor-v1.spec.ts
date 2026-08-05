/**
 * Phase 5 Workstream E tests — P-5/P-5A extraction.
 *
 * Coverage:
 *   - Cost analysis with recurring/nonrecurring categories;
 *   - Production schedule with quantities and deliveries;
 *   - Explicit parent BLIN from manifest;
 *   - Explicit parent BLIN from exhibit text;
 *   - Missing parent BLIN → blocking omission;
 *   - Unsupported layout → blocking omission;
 *   - Duplicate schedule periods → conflict;
 *   - No fabricated funding from narrative text;
 *   - Contract-valid V1 artifact.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractP5FromPages } from './p5-extractor-v1.js';
import { buildP5Artifact } from './p5-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';

const CYCLE_FY = 2027;
const SHA = 'e'.repeat(64);
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
    manifestDocumentKey: 'p5_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/p5.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement' as const,
    exhibit: 'P-5' as const,
    authority: 'dod-comptroller' as const,
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

const P5_EXHIBIT_TEXT =
  'P-5 Cost Analysis\nLI 9670A00005 - MQ-1 UAV\n2031A: Aircraft Procurement, Army';

describe('p5-extractor-v1', () => {
  it('extracts cost analysis with recurring and nonrecurring categories', () => {
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(0, 2, 'FY 2028 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
      makeCell(1, 2, '130.000'),
      makeCell(2, 0, 'Nonrecurring'),
      makeCell(2, 1, '80.000'),
      makeCell(2, 2, '10.000'),
      makeCell(3, 0, 'Total'),
      makeCell(3, 1, '200.000'),
      makeCell(3, 2, '140.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.parentReference).not.toBeNull();
    expect(result.parentReference?.source).toBe('manifest');
    expect(result.parentReference?.printedCode).toBe('9670A00005');
    expect(result.costCategories.length).toBeGreaterThan(0);
    const recurring = result.costCategories.find((c) => c.costCategory === 'recurring');
    const nonrecurring = result.costCategories.find(
      (c) => c.costCategory === 'nonrecurring',
    );
    expect(recurring).toBeDefined();
    expect(nonrecurring).toBeDefined();
    expect(recurring?.valueMillions).toBe('120');
    expect(nonrecurring?.valueMillions).toBe('80');
    expect(result.recognizedLayout).toBe(true);
  });

  it('extracts production schedule with quantities and deliveries', () => {
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(0, 2, 'Deliveries'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
      makeCell(1, 2, '5'),
      makeCell(2, 0, 'FY 2028'),
      makeCell(2, 1, '12'),
      makeCell(2, 2, '10'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.schedule.length).toBeGreaterThanOrEqual(2);
    const fy27 = result.schedule.find((s) => s.periodLabel === 'FY 2027');
    expect(fy27?.quantity).toBe('8');
    expect(fy27?.deliveries).toBe('5');
  });

  it('detects explicit parent BLIN from exhibit text', () => {
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      // No parentBlinCode from manifest — should scan exhibit text.
    });
    expect(result.parentReference).not.toBeNull();
    expect(result.parentReference?.source).toBe('exhibit_text');
    expect(result.parentReference?.printedCode).toBe('9670A00005');
  });

  it('missing parent BLIN becomes blocking omission, not empty success', () => {
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], 'P-5 Cost Analysis — no parent reference here')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentReference).toBeNull();
    expect(result.omissions.some((o) => o.reason.includes('parent'))).toBe(true);
    const parentOmission = result.omissions.find((o) => o.reason.includes('parent'));
    expect(parentOmission?.reason).toContain('fuzzy title matching is prohibited');
  });

  it('unsupported layout becomes blocking omission', () => {
    const table = makeTable([
      makeCell(0, 0, 'Some Random Table'),
      makeCell(0, 1, 'Col A'),
      makeCell(0, 2, 'Col B'),
      makeCell(1, 0, 'Foo'),
      makeCell(1, 1, '1'),
      makeCell(1, 2, '2'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.recognizedLayout).toBe(false);
    expect(result.omissions.some((o) => o.reason.includes('layout'))).toBe(true);
  });

  it('duplicate schedule periods become conflict', () => {
    const scheduleTable = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
    ]);
    const result = extractP5FromPages({
      pages: [
        makePage([scheduleTable], P5_EXHIBIT_TEXT, 1),
        makePage([scheduleTable], P5_EXHIBIT_TEXT, 2),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.conflicts.some((c) => c.reason.includes('duplicate'))).toBe(true);
  });

  it('does not fabricate funding amount from narrative text', () => {
    const narrativeText =
      'P-5 Cost Analysis\nLI 9670A00005 - MQ-1 UAV\nProgram Status: The program spent approximately 500 million dollars last year.';
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    // The narrative mentions "500 million" but no funding assertion should
    // be created from it — only the explicit cost category value of 120.
    const fundingValues = result.costCategories.map((c) => c.valueMillions);
    expect(fundingValues).not.toContain('500');
    expect(fundingValues).toContain('120');
  });

  it('produces a contract-valid V1 artifact', () => {
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
      makeCell(2, 0, 'Nonrecurring'),
      makeCell(2, 1, '80.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(() => parseDefenseBudgetExtractionArtifactV1(artifact)).not.toThrow();
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

  it('explicit parent relationship produces relationship assertion', () => {
    const table = makeTable([
      makeCell(0, 0, 'Cost Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Recurring'),
      makeCell(1, 1, '120.000'),
    ]);
    const result = extractP5FromPages({
      pages: [makePage([table], P5_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const relationships = artifact.assertions.filter(
      (a) => a.assertionKind === 'relationship',
    );
    expect(relationships.length).toBeGreaterThan(0);
    for (const r of relationships) {
      if (r.assertionKind === 'relationship') {
        expect(r.from.lineKind).toBe('PROCUREMENT_BLIN');
        expect(r.to.lineKind).toBe('PROCUREMENT_BLIN');
        expect(r.relationshipType).toBe('other');
        expect(r.explicitInSource).toBe(true);
      }
    }
    // No RDTE_PE identity assertions
    const peIdentities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(peIdentities).toHaveLength(0);
  });
});