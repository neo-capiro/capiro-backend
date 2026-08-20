/**
 * Phase 5 Workstream E tests — P-3A extraction.
 *
 * Coverage:
 *   - Modification/configuration description;
 *   - Narrative sections;
 *   - Explicit parent BLIN from manifest;
 *   - Explicit parent BLIN from exhibit text;
 *   - Missing parent BLIN → blocking omission;
 *   - Unsupported layout → blocking omission;
 *   - Duplicate modification labels → conflict;
 *   - No fabricated funding from narrative text;
 *   - Explicit parent relationship → relationship assertion;
 *   - Contract-valid V1 artifact.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractP3aFromPages } from './p3a-extractor-v1.js';
import { buildP3aArtifact } from './p3a-artifact-builder-v1.js';
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
    manifestDocumentKey: 'p3a_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/p3a.pdf',
    fiscalYear: CYCLE_FY,
    family: 'procurement' as const,
    exhibit: 'P-3A' as const,
    authority: 'dod-comptroller' as const,
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

const P3A_EXHIBIT_TEXT =
  'P-3A Modification Detail\nLI 9670A00005 - MQ-1 UAV\n2031A: Aircraft Procurement, Army';

describe('p3a-extractor-v1', () => {
  it('extracts modification/configuration description', () => {
    const table = makeTable([
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package to include improved IR camera'),
      makeCell(2, 0, 'Configuration A'),
      makeCell(2, 1, 'New configuration with extended range capability'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.parentReference).not.toBeNull();
    expect(result.parentReference?.source).toBe('manifest');
    expect(result.parentReference?.printedCode).toBe('9670A00005');
    expect(result.modifications.length).toBeGreaterThanOrEqual(2);
    const mod1 = result.modifications.find((m) => m.label === 'Mod 1');
    expect(mod1?.description).toContain('sensor package');
    expect(result.recognizedLayout).toBe(true);
  });

  it('detects explicit parent BLIN from exhibit text', () => {
    const table = makeTable([
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
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
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], 'P-3A Modification Detail — no parent reference')],
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
      makeCell(0, 0, 'Random Table'),
      makeCell(0, 1, 'Col A'),
      makeCell(1, 0, 'Foo'),
      makeCell(1, 1, '1'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.recognizedLayout).toBe(false);
    expect(result.omissions.some((o) => o.reason.includes('layout'))).toBe(true);
  });

  it('duplicate modification labels become conflict', () => {
    const modTable = makeTable([
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([modTable], P3A_EXHIBIT_TEXT, 1), makePage([modTable], P3A_EXHIBIT_TEXT, 2)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    expect(result.conflicts.some((c) => c.reason.includes('duplicate'))).toBe(true);
  });

  it('does not fabricate funding amount from narrative text', () => {
    const narrativeText =
      'P-3A Modification Detail\nLI 9670A00005 - MQ-1 UAV\nJustification: This modification costs approximately 500 million dollars.';
    const table = makeTable([
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    // The narrative mentions "500 million" but no funding assertion should be
    // created from it.
    expect(result.funding).toHaveLength(0);
    const artifact = buildP3aArtifact({
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
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package to include improved IR camera'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP3aArtifact({
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
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP3aArtifact({
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

  it('modifications become narrative assertions with description type', () => {
    const table = makeTable([
      makeCell(0, 0, 'Modification'),
      makeCell(0, 1, 'Description'),
      makeCell(1, 0, 'Mod 1'),
      makeCell(1, 1, 'Upgrade sensor package to include improved IR camera'),
    ]);
    const result = extractP3aFromPages({
      pages: [makePage([table], P3A_EXHIBIT_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
      parentBlinCode: '9670A00005',
    });
    const artifact = buildP3aArtifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const narratives = artifact.assertions.filter((a) => a.assertionKind === 'narrative');
    expect(narratives.length).toBeGreaterThan(0);
    for (const n of narratives) {
      if (n.assertionKind === 'narrative') {
        expect(n.identity.lineKind).toBe('PROCUREMENT_BLIN');
      }
    }
  });
});
