/**
 * Phase 5 Workstream E tests — P-21 extraction.
 *
 * Coverage:
 *   - Production/delivery schedule with quantities and deliveries;
 *   - Explicit parent BLIN from manifest;
 *   - Explicit parent BLIN from exhibit text;
 *   - Missing parent BLIN → blocking omission;
 *   - Unsupported layout → blocking omission;
 *   - Duplicate schedule periods → conflict;
 *   - No fabricated funding from narrative text;
 *   - Explicit parent relationship → relationship assertion;
 *   - Contract-valid V1 artifact.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractP21FromPages } from './p21-extractor-v1.js';
import { buildP21Artifact } from './p21-artifact-builder-v1.js';
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
    manifestDocumentKey: 'p21_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/p21.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement' as const,
    exhibit: 'P-21' as const,
    authority: 'dod-comptroller' as const,
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

const P21_EXHIBIT_TEXT =
  'P-21 Production Schedule\nLI 9670A00005 - MQ-1 UAV\n2031A: Aircraft Procurement, Army';

describe('p21-extractor-v1', () => {
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
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.parentReference).not.toBeNull();
    expect(result.parentReference?.source).toBe('manifest');
    expect(result.parentReference?.printedCode).toBe('9670A00005');
    expect(result.schedule.length).toBeGreaterThanOrEqual(2);
    const fy27 = result.schedule.find((s) => s.periodLabel === 'FY 2027');
    expect(fy27?.quantity).toBe('8');
    expect(fy27?.deliveries).toBe('5');
    expect(result.recognizedLayout).toBe(true);
  });

  it('extracts quarterly schedule periods', () => {
    const table = makeTable([
      makeCell(0, 0, 'Delivery Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(0, 2, 'Deliveries'),
      makeCell(1, 0, '1Q FY 2027'),
      makeCell(1, 1, '2'),
      makeCell(1, 2, '1'),
      makeCell(2, 0, '2Q FY 2027'),
      makeCell(2, 1, '3'),
      makeCell(2, 2, '2'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.schedule.length).toBeGreaterThanOrEqual(2);
    const q1 = result.schedule.find((s) => s.periodLabel === '1Q FY 2027');
    expect(q1?.fiscalYear).toBe(2027);
    expect(q1?.quantity).toBe('2');
  });

  it('detects explicit parent BLIN from exhibit text', () => {
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentReference).not.toBeNull();
    expect(result.parentReference?.source).toBe('exhibit_text');
    expect(result.parentReference?.printedCode).toBe('9670A00005');
  });

  it('missing parent BLIN becomes blocking omission, not empty success', () => {
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], 'P-21 Production Schedule — no parent here')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.parentReference).toBeNull();
    expect(result.omissions.some((o) => o.reason.includes('parent'))).toBe(true);
  });

  it('unsupported layout becomes blocking omission', () => {
    const table = makeTable([
      makeCell(0, 0, 'Random Table'),
      makeCell(0, 1, 'Col A'),
      makeCell(1, 0, 'Foo'),
      makeCell(1, 1, '1'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
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
    const result = extractP21FromPages({
      pages: [
        makePage([scheduleTable], P21_EXHIBIT_TEXT, 1),
        makePage([scheduleTable], P21_EXHIBIT_TEXT, 2),
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
      'P-21 Production Schedule\nLI 9670A00005 - MQ-1 UAV\nProgram Status: The program expects 500 million in FY 2027.';
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    // No funding values should be present — P-21 is a schedule exhibit.
    expect(result.schedule.length).toBeGreaterThan(0);
    // The "500 million" in the narrative must not become a funding assertion.
    const artifact = buildP21Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions).toHaveLength(0);
  });

  it('produces a contract-valid V1 artifact', () => {
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(0, 2, 'Deliveries'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
      makeCell(1, 2, '5'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP21Artifact({
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

  it('explicit parent relationship produces relationship assertion', () => {
    const table = makeTable([
      makeCell(0, 0, 'Production Schedule'),
      makeCell(0, 1, 'Quantity'),
      makeCell(1, 0, 'FY 2027'),
      makeCell(1, 1, '8'),
    ]);
    const result = extractP21FromPages({
      pages: [makePage([table], P21_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP21Artifact({
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
        expect(r.to.lineKind).toBe('PROCUREMENT_BLIN');
        expect(r.relationshipType).toBe('other');
        expect(r.explicitInSource).toBe(true);
      }
    }
    const peIdentities = artifact.assertions.filter(
      (a) => a.assertionKind === 'program_element_identity',
    );
    expect(peIdentities).toHaveLength(0);
  });
});
