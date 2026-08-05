/**
 * Phase 5 Workstream H tests — OP-5 (O&M detail) extraction.
 *
 * Representative fixtures for:
 *   - Multi-page SAG section (continuation page);
 *   - Price/program change table (document_fact assertions for changes);
 *   - Narrative sections (mission, budget_justification);
 *   - Quantity/workload table;
 *   - Missing identity header (blocking omission);
 *   - Duplicate SAG sections (conflict detection);
 *   - Total-change arithmetic where source explicitly defines it;
 *   - Non-equivalent scopes marked not applicable (no arithmetic);
 *   - Contract-valid V1 artifact;
 *   - Narrative text is NOT used as money without a printed numeric assertion.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractOp5FromPages } from './op5-extractor-v1.js';
import { buildOp5Artifact } from './op5-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';

const CYCLE_FY = 2027;
const SHA = 'e'.repeat(64);
const ACCOUNT = 'O&M, Army';
const COMPONENT = 'ARMY' as const;

const OP5_HEADER =
  'O&M, Army ($ in Millions)\nBA 01: Operating Forces\nBAG 1: Deployed Forces\nSAG 1A: Centralized Training';

function makeCell(
  rowIndex: number,
  columnIndex: number,
  text: string,
): ParsedTableCellV1 {
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
    manifestDocumentKey: 'op5_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/op5.pdf',
    fiscalYear: CYCLE_FY,
    family: 'om',
    exhibit: 'OP-5',
    authority: 'dod-comptroller',
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

describe('op5-extractor-v1', () => {
  /* ---------------------------------------------------------------- */
  /* 1. Multi-page SAG section                                        */
  /* ---------------------------------------------------------------- */
  it('extracts a multi-page SAG section with continuation page', () => {
    const fundingTable = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 2, 'FY 2026 Enacted ($ in Millions)'),
      makeCell(1, 0, 'Direct Program'),
      makeCell(1, 1, '100.0'),
      makeCell(1, 2, '150.0'),
      makeCell(2, 0, 'Reimbursable'),
      makeCell(2, 1, '20.0'),
      makeCell(2, 2, '30.0'),
      makeCell(3, 0, 'Total'),
      makeCell(3, 1, '120.0'),
      makeCell(3, 2, '180.0'),
    ]);
    const requestTable = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Direct Program'),
      makeCell(1, 1, '200.0'),
      makeCell(2, 0, 'Reimbursable'),
      makeCell(2, 1, '40.0'),
      makeCell(3, 0, 'Total'),
      makeCell(3, 1, '240.0'),
    ]);
    const result = extractOp5FromPages({
      pages: [
        makePage([fundingTable], OP5_HEADER, 1),
        // Continuation page: no SAG header, just more data.
        makePage([requestTable], 'Centralized Training (continued)', 2),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedCode).toBe('1A');
    expect(result.identities[0]?.title).toBe('Centralized Training');
    expect(result.identities[0]?.budgetActivity).toBe('BA 01');
    expect(result.identities[0]?.activityGroup).toBe('BAG 1');
    expect(result.identities[0]?.subActivityGroup).toBe('1A');
    // FY 2025 + FY 2026 from page 1 (3 rows × 2 FYs = 6),
    // FY 2027 from page 2 (3 rows × 1 FY = 3) → 9 total funding values.
    // Total rows are extracted as funding values (they are source-printed).
    expect(result.funding).toHaveLength(9);
    const fy2027Total = result.funding.find(
      (f) => f.rowLabel === 'Total' && f.fiscalYear === 2027,
    );
    expect(fy2027Total?.valueMillions).toBe('240');
    const fy2025Direct = result.funding.find(
      (f) => f.rowLabel === 'Direct Program' && f.fiscalYear === 2025,
    );
    expect(fy2025Direct?.valueMillions).toBe('100');
  });

  /* ---------------------------------------------------------------- */
  /* 2. Price/program change table (document_fact assertions)         */
  /* ---------------------------------------------------------------- */
  it('extracts price/program change table as document_fact assertions', () => {
    const changeTable = makeTable([
      makeCell(0, 0, 'Change Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Price Change'),
      makeCell(1, 1, '10.0'),
      makeCell(2, 0, 'Program Change'),
      makeCell(2, 1, '20.0'),
      makeCell(3, 0, 'Transfers'),
      makeCell(3, 1, '5.0'),
      makeCell(4, 0, 'Total Change'),
      makeCell(4, 1, '35.0'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([changeTable], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.changes).toHaveLength(4);
    const changeTypes = result.changes.map((c) => c.changeType);
    expect(changeTypes).toContain('price_change');
    expect(changeTypes).toContain('program_change');
    expect(changeTypes).toContain('transfer');
    expect(changeTypes).toContain('total_change');
    // Changes should NOT be funding assertions.
    expect(result.funding).toHaveLength(0);
    // Verify the artifact emits document_fact assertions, not funding.
    const artifact = buildOp5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const docFacts = artifact.assertions.filter(
      (a) => a.assertionKind === 'document_fact',
    );
    expect(docFacts.length).toBe(4);
    const fundingAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'funding',
    );
    expect(fundingAssertions.length).toBe(0);
    // Each document_fact has fieldName matching the change type.
    for (const df of docFacts) {
      if (df.assertionKind === 'document_fact') {
        expect(['price_change', 'program_change', 'transfer', 'total_change']).toContain(df.fieldName);
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* 3. Narrative sections (mission, budget_justification)            */
  /* ---------------------------------------------------------------- */
  it('extracts narrative sections (mission and budget justification)', () => {
    const narrativeText = `${OP5_HEADER}
Mission: Provide centralized training for operating forces.
Description: This activity funds training operations.
Budget Justification: The FY 2027 request supports 5% growth in training throughput.`;
    const result = extractOp5FromPages({
      pages: [makePage([], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    const sectionTypes = result.narratives.map((n) => n.sectionType);
    expect(sectionTypes).toContain('mission');
    expect(sectionTypes).toContain('budget_justification');
    const missionNarrative = result.narratives.find(
      (n) => n.sectionType === 'mission',
    );
    expect(missionNarrative?.narrativeType).toBe('mission');
    expect(missionNarrative?.text).toContain('centralized training');
    const justificationNarrative = result.narratives.find(
      (n) => n.sectionType === 'budget_justification',
    );
    expect(justificationNarrative?.narrativeType).toBe('rationale');
    expect(justificationNarrative?.text).toContain('FY 2027 request');
  });

  /* ---------------------------------------------------------------- */
  /* 4. Quantity/workload table                                       */
  /* ---------------------------------------------------------------- */
  it('extracts quantity/workload table as quantity assertions', () => {
    const workloadTable = makeTable([
      makeCell(0, 0, 'Workload Measure'),
      makeCell(0, 1, 'FY 2025'),
      makeCell(0, 2, 'FY 2026'),
      makeCell(0, 3, 'FY 2027'),
      makeCell(1, 0, 'Training Days'),
      makeCell(1, 1, '1000'),
      makeCell(1, 2, '1100'),
      makeCell(1, 3, '1200'),
      makeCell(2, 0, 'Students Trained'),
      makeCell(2, 1, '500'),
      makeCell(2, 2, '550'),
      makeCell(2, 3, '600'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([workloadTable], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.quantities.length).toBeGreaterThan(0);
    const trainingDays = result.quantities.find(
      (q) => q.rowLabel === 'Training Days' && q.fiscalYear === 2027,
    );
    expect(trainingDays?.quantity).toBe('1200');
    const students2025 = result.quantities.find(
      (q) => q.rowLabel === 'Students Trained' && q.fiscalYear === 2025,
    );
    expect(students2025?.quantity).toBe('500');
    // Verify the artifact emits quantity assertions with OM_SAG identity.
    const artifact = buildOp5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const qtyAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'quantity',
    );
    expect(qtyAssertions.length).toBeGreaterThan(0);
    for (const qa of qtyAssertions) {
      if (qa.assertionKind === 'quantity') {
        expect(qa.identity.lineKind).toBe('OM_SAG');
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* 5. Missing identity header (blocking omission)                  */
  /* ---------------------------------------------------------------- */
  it('emits blocking omission when SAG identity header is missing', () => {
    const fundingTable = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Direct Program'),
      makeCell(1, 1, '200.0'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([fundingTable], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(0);
    const blockingOmissions = result.omissions.filter(
      (o) => o.severity === 'blocking' && o.reason.includes('SAG'),
    );
    expect(blockingOmissions.length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- */
  /* 6. Duplicate SAG sections (conflict detection)                   */
  /* ---------------------------------------------------------------- */
  it('detects duplicate SAG sections with conflicting funding values', () => {
    const table1 = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Total'),
      makeCell(1, 1, '100.0'),
    ]);
    const table2 = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Total'),
      makeCell(1, 1, '200.0'),
    ]);
    // Both pages have the same SAG header → same natural key.
    const result = extractOp5FromPages({
      pages: [
        makePage([table1], OP5_HEADER, 1),
        makePage([table2], OP5_HEADER, 2),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
    const conflict = result.conflicts[0]!;
    expect(conflict.fiscalYear).toBe(2027);
    expect(conflict.rowLabel).toBe('Total');
    expect(conflict.values).toContain('100');
    expect(conflict.values).toContain('200');
    expect(conflict.pages).toContain(1);
    expect(conflict.pages).toContain(2);
  });

  /* ---------------------------------------------------------------- */
  /* 7. Total-change arithmetic where source explicitly defines it    */
  /* ---------------------------------------------------------------- */
  it('checks total-change arithmetic when source defines equivalent scope', () => {
    const changeTable = makeTable([
      makeCell(0, 0, 'Change Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Price Change'),
      makeCell(1, 1, '10.0'),
      makeCell(2, 0, 'Program Change'),
      makeCell(2, 1, '20.0'),
      makeCell(3, 0, 'Transfers'),
      makeCell(3, 1, '5.0'),
      makeCell(4, 0, 'Total Change'),
      makeCell(4, 1, '35.0'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([changeTable], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.totalChangeArithmetic.applicable).toBe(true);
    expect(result.totalChangeArithmetic.passed).toBe(true);
    expect(result.totalChangeArithmetic.expected).toBe('35');
    expect(result.totalChangeArithmetic.actual).toBe('35');
    expect(result.totalChangeArithmetic.fiscalYear).toBe(2027);
  });

  /* ---------------------------------------------------------------- */
  /* 8. Non-equivalent scopes marked not applicable                   */
  /* ---------------------------------------------------------------- */
  it('marks total-change arithmetic not applicable for non-equivalent scopes', () => {
    // Only Price Change and Program Change — no Total Change row.
    const partialChangeTable = makeTable([
      makeCell(0, 0, 'Change Analysis'),
      makeCell(0, 1, 'FY 2027 ($ in Millions)'),
      makeCell(1, 0, 'Price Change'),
      makeCell(1, 1, '10.0'),
      makeCell(2, 0, 'Program Change'),
      makeCell(2, 1, '20.0'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([partialChangeTable], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.totalChangeArithmetic.applicable).toBe(false);
    // Still extracts the change values as document_facts.
    expect(result.changes).toHaveLength(2);
  });

  /* ---------------------------------------------------------------- */
  /* 9. Produces a contract-valid V1 artifact                         */
  /* ---------------------------------------------------------------- */
  it('produces a contract-valid V1 artifact', () => {
    const fundingTable = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Direct Program'),
      makeCell(1, 1, '100.0'),
      makeCell(1, 2, '200.0'),
      makeCell(2, 0, 'Total'),
      makeCell(2, 1, '100.0'),
      makeCell(2, 2, '200.0'),
    ]);
    const narrativeText = `${OP5_HEADER}
Mission: Provide centralized training.
Budget Justification: The request supports training readiness.`;
    const result = extractOp5FromPages({
      pages: [makePage([fundingTable], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildOp5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    expect(() =>
      parseDefenseBudgetExtractionArtifactV1(artifact),
    ).not.toThrow();
    expect(artifact.summary.assertionCount).toBeGreaterThan(0);
    // All om_line identities are OM_SAG, never RDTE_PE or PROCUREMENT_BLIN.
    const omLines = artifact.assertions.filter(
      (a) => a.assertionKind === 'om_line',
    );
    expect(omLines.length).toBeGreaterThan(0);
    for (const a of omLines) {
      if (a.assertionKind === 'om_line') {
        expect(a.identity.lineKind).toBe('OM_SAG');
      }
    }
    // All funding assertions have OM_SAG identity.
    const fundingAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'funding',
    );
    expect(fundingAssertions.length).toBeGreaterThan(0);
    for (const a of fundingAssertions) {
      if (a.assertionKind === 'funding') {
        expect(a.identity.lineKind).toBe('OM_SAG');
      }
    }
    // All narrative assertions have OM_SAG identity.
    const narrativeAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'narrative',
    );
    expect(narrativeAssertions.length).toBeGreaterThan(0);
    for (const a of narrativeAssertions) {
      if (a.assertionKind === 'narrative') {
        expect(a.identity.lineKind).toBe('OM_SAG');
      }
    }
  });

  /* ---------------------------------------------------------------- */
  /* 10. Narrative text is NOT used as money                          */
  /* ---------------------------------------------------------------- */
  it('does not use narrative text as money without a printed numeric assertion', () => {
    // Narrative mentions "$100 million" and "5%" but these are prose,
    // not printed numeric table cells.
    const narrativeText = `${OP5_HEADER}
Mission: Provide centralized training.
Budget Justification: The FY 2027 request of $100 million represents a 5% increase over FY 2026.
The program supports 1,200 training days annually.`;
    // No tables — only narrative text.
    const result = extractOp5FromPages({
      pages: [makePage([], narrativeText)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    // No funding values should be extracted from narrative text.
    expect(result.funding).toHaveLength(0);
    // No changes should be extracted from narrative text.
    expect(result.changes).toHaveLength(0);
    // No quantities should be extracted from narrative text.
    expect(result.quantities).toHaveLength(0);
    // Narratives ARE extracted (the text content, not as money).
    expect(result.narratives.length).toBeGreaterThan(0);
    // The artifact should not contain any funding assertions.
    const artifact = buildOp5Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const fundingAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'funding',
    );
    expect(fundingAssertions).toHaveLength(0);
    const docFactAssertions = artifact.assertions.filter(
      (a) => a.assertionKind === 'document_fact',
    );
    expect(docFactAssertions).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- */
  /* Bonus: Exact decimal strings preserved                          */
  /* ---------------------------------------------------------------- */
  it('preserves exact decimal strings without magnitude-based inference', () => {
    const fundingTable = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Total'),
      makeCell(1, 1, '240.123'),
    ]);
    const result = extractOp5FromPages({
      pages: [makePage([fundingTable], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.originalValue).toBe('240.123');
    expect(result.funding[0]?.valueMillions).toBe('240.123');
    expect(result.funding[0]?.originalUnit).toBe('millions');
  });

  /* ---------------------------------------------------------------- */
  /* Bonus: Same SAG code under different accounts is distinct        */
  /* ---------------------------------------------------------------- */
  it('same SAG code under different accounts produces distinct identities', () => {
    const table = makeTable([
      makeCell(0, 0, 'Description'),
      makeCell(0, 1, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, 'Total'),
      makeCell(1, 1, '100.0'),
    ]);
    const result1 = extractOp5FromPages({
      pages: [makePage([table], OP5_HEADER)],
      cycleFiscalYear: CYCLE_FY,
      account: 'O&M, Army',
      component: COMPONENT,
    });
    const result2 = extractOp5FromPages({
      pages: [makePage([table], 'O&M, Navy ($ in Millions)\nBA 01: ...\nSAG 1A: Training')],
      cycleFiscalYear: CYCLE_FY,
      account: 'O&M, Navy',
      component: 'NAVY' as const,
    });
    expect(result1.identities[0]?.identity.naturalKey).not.toBe(
      result2.identities[0]?.identity.naturalKey,
    );
  });
});