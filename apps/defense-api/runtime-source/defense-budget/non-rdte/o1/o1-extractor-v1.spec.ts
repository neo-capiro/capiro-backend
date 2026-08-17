/**
 * Phase 5 Workstream G tests — O-1 master extraction.
 *
 * Representative fixtures for:
 *   - BA/BAG/SAG hierarchy;
 *   - Same SAG under different accounts/components (distinct identities);
 *   - Base/OCO/total columns;
 *   - Prior/current/request columns;
 *   - Subtotal rows (not treated as SAG identities);
 *   - Repeated headers and page continuation;
 *   - Missing SAG code (blocking omission);
 *   - Unknown unit (blocking omission);
 *   - Contract-valid V1 artifact;
 *   - No O-1 identity is stored as RDTE_PE or PROCUREMENT_BLIN.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { extractO1FromPages } from './o1-extractor-v1.js';
import { buildO1Artifact } from './o1-artifact-builder-v1.js';
import type { ExtractionSourceV1 } from '../../contracts/extraction-artifact-v1.js';
import { parseDefenseBudgetExtractionArtifactV1 } from '../../contracts/extraction-artifact-v1.semantic.js';

const CYCLE_FY = 2027;
const SHA = 'e'.repeat(64);
const ACCOUNT = 'O&M, Army';
const COMPONENT = 'ARMY' as const;

function makeCell(rowIndex: number, columnIndex: number, text: string): ParsedTableCellV1 {
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

function makePage(tables: ParsedTableV1[], text?: string, page = 1): ParserPageResultV1 {
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
    manifestDocumentKey: 'o1_army',
    sourcePdfSha256: SHA,
    sourceLocator: 's3://b/o1.pdf',
    fiscalYear: CYCLE_FY,
    family: 'om',
    exhibit: 'O-1',
    authority: 'dod-comptroller',
    component: COMPONENT,
    budgetCycle: 'pb_fy2027',
    documentType: 'pb_exhibit',
  };
}

describe('o1-extractor-v1', () => {
  it('extracts BA/BAG/SAG hierarchy', () => {
    const table = makeTable([
      makeCell(0, 0, 'BA'),
      makeCell(0, 1, 'BAG'),
      makeCell(0, 2, 'SAG'),
      makeCell(0, 3, 'Title'),
      makeCell(0, 4, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, '1'),
      makeCell(1, 2, '01'),
      makeCell(1, 3, 'Centralized Training'),
      makeCell(1, 4, '120.5'),
      makeCell(2, 0, '01'),
      makeCell(2, 1, '1'),
      makeCell(2, 2, '02'),
      makeCell(2, 3, 'Decentralized Training'),
      makeCell(2, 4, '80.0'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(2);
    expect(result.identities[0]?.printedCode).toBe('01');
    expect(result.identities[0]?.title).toBe('Centralized Training');
    expect(result.identities[0]?.budgetActivity).toBe('01');
    expect(result.identities[0]?.activityGroup).toBe('1');
    expect(result.identities[0]?.subActivityGroup).toBe('01');
    expect(result.identities[0]?.identity.lineKind).toBe('OM_SAG');
    expect(result.identities[1]?.printedCode).toBe('02');
    expect(result.identities[1]?.title).toBe('Decentralized Training');
    expect(result.funding).toHaveLength(2);
    expect(result.unitResolution.unit).toBe('millions');
  });

  it('same SAG code under different accounts produces distinct identities', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const armyResult = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: 'O&M, Army',
      component: 'ARMY' as const,
    });
    const navyResult = extractO1FromPages({
      pages: [makePage([table], 'O&M, Navy ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: 'O&M, Navy',
      component: 'NAVY' as const,
    });
    expect(armyResult.identities[0]?.identity.naturalKey).not.toBe(
      navyResult.identities[0]?.identity.naturalKey,
    );
    expect(armyResult.identities[0]?.identity.account).toBe('O&M, ARMY');
    expect(navyResult.identities[0]?.identity.account).toBe('O&M, NAVY');
  });

  it('same SAG code under different components produces distinct identities', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const armyResult = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: 'ARMY' as const,
    });
    const afResult = extractO1FromPages({
      pages: [makePage([table], 'O&M, AF ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: 'AF' as const,
    });
    expect(armyResult.identities[0]?.identity.naturalKey).not.toBe(
      afResult.identities[0]?.identity.naturalKey,
    );
  });

  it('handles base/OCO/total columns', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Base ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 OCO ($ in Millions)'),
      makeCell(0, 4, 'FY 2027 Total ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '100.0'),
      makeCell(1, 3, '30.0'),
      makeCell(1, 4, '130.0'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(3);
    const baseFunding = result.funding.find((f) => f.columnBinding.baseOcoStatus === 'base');
    const ocoFunding = result.funding.find((f) => f.columnBinding.baseOcoStatus === 'oco');
    const totalFunding = result.funding.find((f) => f.columnBinding.baseOcoStatus === 'total');
    expect(baseFunding?.valueMillions).toBe('100');
    expect(ocoFunding?.valueMillions).toBe('30');
    expect(totalFunding?.valueMillions).toBe('130');
  });

  it('handles prior/current/request columns', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 3, 'FY 2026 Enacted ($ in Millions)'),
      makeCell(0, 4, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '110.0'),
      makeCell(1, 3, '115.0'),
      makeCell(1, 4, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(3);
    const actualVal = result.funding.find((f) => f.columnBinding.fundingStage === 'prior_actual');
    const enactedVal = result.funding.find(
      (f) => f.columnBinding.fundingStage === 'current_enacted',
    );
    const requestVal = result.funding.find(
      (f) => f.columnBinding.fundingStage === 'budget_year_request',
    );
    expect(actualVal?.valueMillions).toBe('110');
    expect(actualVal?.fiscalYear).toBe(2025);
    expect(enactedVal?.valueMillions).toBe('115');
    expect(enactedVal?.fiscalYear).toBe(2026);
    expect(requestVal?.valueMillions).toBe('120.5');
    expect(requestVal?.fiscalYear).toBe(2027);
  });

  it('subtotal rows are not treated as SAG identities', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
      makeCell(2, 0, ''),
      makeCell(2, 1, 'Total BA 01'),
      makeCell(2, 2, '200.5'),
      makeCell(3, 0, '02'),
      makeCell(3, 1, 'Decentralized Training'),
      makeCell(3, 2, '80.0'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(2);
    expect(result.identities[0]?.printedCode).toBe('01');
    expect(result.identities[1]?.printedCode).toBe('02');
    // The total row should not be an identity
    expect(result.identities.find((i) => i.title === 'Total BA 01')).toBeUndefined();
  });

  it('handles repeated headers on continuation pages without duplicate identities', () => {
    const header = [
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
    ];
    const page1Table = makeTable([
      ...header,
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const page2Table = makeTable([
      ...header,
      makeCell(1, 0, '02'),
      makeCell(1, 1, 'Decentralized Training'),
      makeCell(1, 2, '80.0'),
    ]);
    const result = extractO1FromPages({
      pages: [
        makePage([page1Table], 'O&M, Army ($ in Millions)', 1),
        makePage([page2Table], 'O&M, Army ($ in Millions)', 2),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(2);
    expect(result.identities[0]?.printedCode).toBe('01');
    expect(result.identities[1]?.printedCode).toBe('02');
  });

  it('does not create duplicate identity when same SAG appears on continuation page', () => {
    const header = [
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
    ];
    const page1Table = makeTable([
      ...header,
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    // Same SAG code repeated on page 2 (e.g., due to a page-break repeat)
    const page2Table = makeTable([
      ...header,
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [
        makePage([page1Table], 'O&M, Army ($ in Millions)', 1),
        makePage([page2Table], 'O&M, Army ($ in Millions)', 2),
      ],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    // Only one identity despite the repeat
    expect(result.identities).toHaveLength(1);
  });

  it('missing SAG code emits blocking omission', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, ''),
      makeCell(1, 1, 'Some Activity'),
      makeCell(1, 2, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.reason).toContain('SAG code');
  });

  it('unknown unit emits blocking omission', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    // No unit indicator in page text or table label
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army Summary')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.omissions.length).toBeGreaterThanOrEqual(1);
    expect(result.omissions.some((o) => o.reason.includes('unit'))).toBe(true);
    // No funding should be emitted when unit is unknown
    expect(result.funding).toHaveLength(0);
  });

  it('produces a contract-valid V1 artifact', () => {
    const table = makeTable([
      makeCell(0, 0, 'BA'),
      makeCell(0, 1, 'BAG'),
      makeCell(0, 2, 'SAG'),
      makeCell(0, 3, 'Title'),
      makeCell(0, 4, 'FY 2025 Actual ($ in Millions)'),
      makeCell(0, 5, 'FY 2026 Enacted ($ in Millions)'),
      makeCell(0, 6, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, '1'),
      makeCell(1, 2, '01'),
      makeCell(1, 3, 'Centralized Training'),
      makeCell(1, 4, '110.0'),
      makeCell(1, 5, '115.0'),
      makeCell(1, 6, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildO1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    // Should be schema-valid and semantically valid
    expect(() => parseDefenseBudgetExtractionArtifactV1(artifact)).not.toThrow();
    expect(artifact.summary.assertionCount).toBeGreaterThan(0);

    // All identity assertions are om_line with OM_SAG
    const omLines = artifact.assertions.filter((a) => a.assertionKind === 'om_line');
    expect(omLines.length).toBeGreaterThan(0);
    for (const a of omLines) {
      expect(a.identity.lineKind).toBe('OM_SAG');
    }

    // Funding assertions should reference OM_SAG identities
    const fundingAssertions = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(fundingAssertions.length).toBeGreaterThan(0);
    for (const a of fundingAssertions) {
      expect(a.identity.lineKind).toBe('OM_SAG');
    }
  });

  it('no O-1 identity is stored as RDTE_PE or PROCUREMENT_BLIN', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildO1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    for (const a of artifact.assertions) {
      if ('identity' in a && a.identity != null) {
        expect(a.identity.lineKind).not.toBe('RDTE_PE');
        expect(a.identity.lineKind).not.toBe('PROCUREMENT_BLIN');
      }
      if ('parentIdentity' in a && a.parentIdentity != null) {
        expect(a.parentIdentity.lineKind).not.toBe('RDTE_PE');
      }
    }
  });

  it('handles negative/parenthesized values', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '(50.0)'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.originalValue).toBe('-50');
  });

  it('handles blank and dash values', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2025 ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '-'),
      makeCell(1, 3, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.valueMillions).toBe('120.5');
  });

  it('carries BA/BAG context across rows within a table', () => {
    const table = makeTable([
      makeCell(0, 0, 'BA'),
      makeCell(0, 1, 'BAG'),
      makeCell(0, 2, 'SAG'),
      makeCell(0, 3, 'Title'),
      makeCell(0, 4, 'FY 2027 Request ($ in Millions)'),
      // First SAG row has BA/BAG
      makeCell(1, 0, '01'),
      makeCell(1, 1, '1'),
      makeCell(1, 2, '01'),
      makeCell(1, 3, 'Centralized Training'),
      makeCell(1, 4, '120.5'),
      // Second SAG row leaves BA/BAG blank (merged-cell style)
      makeCell(2, 0, ''),
      makeCell(2, 1, ''),
      makeCell(2, 2, '02'),
      makeCell(2, 3, 'Decentralized Training'),
      makeCell(2, 4, '80.0'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(2);
    expect(result.identities[0]?.budgetActivity).toBe('01');
    expect(result.identities[0]?.activityGroup).toBe('1');
    // Second row should inherit BA/BAG from the first
    expect(result.identities[1]?.budgetActivity).toBe('01');
    expect(result.identities[1]?.activityGroup).toBe('1');
  });

  it('detects BA/BAG from section header rows', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      // BA section header row
      makeCell(1, 0, ''),
      makeCell(1, 1, 'BA 01: Operating Forces'),
      makeCell(1, 2, ''),
      // BAG section header row
      makeCell(2, 0, ''),
      makeCell(2, 1, 'BAG 1: Operations'),
      makeCell(2, 2, ''),
      // SAG data row
      makeCell(3, 0, '01'),
      makeCell(3, 1, 'Centralized Training'),
      makeCell(3, 2, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedCode).toBe('01');
    expect(result.identities[0]?.budgetActivity).toBe('BA 01');
    expect(result.identities[0]?.activityGroup).toBe('BAG 1');
  });

  it('does not use positional fallback for FY binding', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    expect(result.usedPositionalFallback).toBe(false);
    expect(result.headerBinding.unresolvedColumnIndices).toHaveLength(0);
  });

  it('funding field reflects request vs enacted from column header', () => {
    const table = makeTable([
      makeCell(0, 0, 'SAG'),
      makeCell(0, 1, 'Title'),
      makeCell(0, 2, 'FY 2026 Enacted ($ in Millions)'),
      makeCell(0, 3, 'FY 2027 Request ($ in Millions)'),
      makeCell(1, 0, '01'),
      makeCell(1, 1, 'Centralized Training'),
      makeCell(1, 2, '115.0'),
      makeCell(1, 3, '120.5'),
    ]);
    const result = extractO1FromPages({
      pages: [makePage([table], 'O&M, Army ($ in Millions)')],
      cycleFiscalYear: CYCLE_FY,
      account: ACCOUNT,
      component: COMPONENT,
    });
    const artifact = buildO1Artifact({
      source: makeSource(),
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });
    const funding = artifact.assertions.filter((a) => a.assertionKind === 'funding');
    expect(funding).toHaveLength(2);
    const enacted = funding.find((f) => f.fiscalYear === 2026);
    const request = funding.find((f) => f.fiscalYear === 2027);
    expect(enacted?.field).toBe('enacted');
    expect(request?.field).toBe('request');
  });
});
