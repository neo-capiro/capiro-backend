/**
 * Phase 5 Workstream J tests — C-1 (MILCON Summary) extraction.
 */
import { extractC1FromPages } from './c1-extractor-v1.js';
import { buildC1Artifact } from './c1-artifact-builder-v1.js';
import type { ParserPageResultV1, ParsedTableV1, ParsedTableCellV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';

const CYCLE_FY = 2027;
const COMPONENT: BudgetComponentV1 = 'ARMY';
const ACCOUNT = 'Military Construction, Army';

function makeCell(
  rowIndex: number,
  columnIndex: number,
  text: string,
): ParsedTableCellV1 {
  return { rowIndex, columnIndex, text };
}

function makeTable(
  tableIndex: number,
  cells: ParsedTableCellV1[],
  label?: string,
): ParsedTableV1 {
  return {
    tableIndex,
    ...(label != null ? { label } : {}),
    rowCount: Math.max(...cells.map((c) => c.rowIndex)) + 1,
    columnCount: Math.max(...cells.map((c) => c.columnIndex)) + 1,
    cells,
    warnings: [],
  };
}

function makePage(
  page: number,
  tables: ParsedTableV1[],
  text?: string,
): ParserPageResultV1 {
  return {
    page,
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
    ...(text != null ? { text } : {}),
  };
}

describe('c1-extractor-v1', () => {
  it('extracts domestic project with funding', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Installation'),
      makeCell(0, 3, 'Request'),
      /* Data row */
      makeCell(1, 0, 'ABC-12345'),
      makeCell(1, 1, 'New Barracks'),
      makeCell(1, 2, 'Fort Bragg, NC'),
      makeCell(1, 3, '45,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedProjectCode).toBe('ABC-12345');
    expect(result.identities[0]?.projectTitle).toBe('New Barracks');
    expect(result.identities[0]?.installation).toBe('Fort Bragg, NC');
    expect(result.identities[0]?.identity.lineKind).toBe('MILCON_PROJECT');
    expect(result.funding).toHaveLength(1);
    expect(result.funding[0]?.fundingType).toBe('request');
    expect(result.funding[0]?.originalValue).toBe('45000');
    expect(result.funding[0]?.valueMillions).toBe('45');
    expect(result.omissions).toHaveLength(0);
  });

  it('same project number with different component/location remains distinct', () => {
    const table1 = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Installation'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'XYZ-999'),
      makeCell(1, 1, 'Fort Hood, TX'),
      makeCell(1, 2, '30,000'),
    ], 'Cost in Thousands');

    const table2 = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Installation'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'XYZ-999'),
      makeCell(1, 1, 'Naval Base San Diego, CA'),
      makeCell(1, 2, '25,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [
        makePage(1, [table1]),
        makePage(2, [table2]),
      ],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(2);
    expect(result.identities[0]?.identity.naturalKey).not.toBe(
      result.identities[1]?.identity.naturalKey,
    );
  });

  it('phased project preserves both instances', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'PH1-001'),
      makeCell(1, 1, 'Phase 1 Barracks'),
      makeCell(1, 2, '20,000'),
      makeCell(2, 0, 'PH2-001'),
      makeCell(2, 1, 'Phase 2 Barracks'),
      makeCell(2, 2, '15,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(2);
    expect(result.funding).toHaveLength(2);
  });

  it('summary/subtotal row is not a project identity', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Request'),
      makeCell(1, 0, 'ABC-111'),
      makeCell(1, 1, '10,000'),
      makeCell(2, 0, 'Total'),
      makeCell(2, 1, '10,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedProjectCode).toBe('ABC-111');
  });

  it('multiple funding fields remain separate', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Request'),
      makeCell(0, 2, 'Authorization'),
      makeCell(0, 3, 'Total Project Cost'),
      makeCell(1, 0, 'MUL-001'),
      makeCell(1, 1, '50,000'),
      makeCell(1, 2, '45,000'),
      makeCell(1, 3, '120,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.funding).toHaveLength(3);
    const types = result.funding.map((f) => f.fundingType).sort();
    expect(types).toEqual(['authorization', 'request', 'total_project_cost']);
  });

  it('missing project number is blocking omission', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, ''),
      makeCell(1, 1, 'Unknown Project'),
      makeCell(1, 2, '5,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.severity).toBe('blocking');
    expect(result.omissions[0]?.reason).toContain('missing project number');
  });

  it('wrapped title is captured', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'WRP-001'),
      makeCell(1, 1, 'Construction of New Medical Facility and Supporting Infrastructure'),
      makeCell(1, 2, '85,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.projectTitle).toContain('Medical Facility');
  });

  it('detects unit from page text', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Request'),
      makeCell(1, 0, 'UNT-001'),
      makeCell(1, 1, '100'),
    ]);

    const result = extractC1FromPages({
      pages: [makePage(1, [table], 'All amounts in Millions of Dollars')],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.unitResolution.unit).toBe('millions');
    expect(result.funding[0]?.originalUnit).toBe('millions');
    expect(result.funding[0]?.valueMillions).toBe('100');
  });

  it('overseas project with location', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Installation'),
      makeCell(0, 3, 'Location'),
      makeCell(0, 4, 'Request'),
      makeCell(1, 0, 'OVS-001'),
      makeCell(1, 1, 'Overseas Facility'),
      makeCell(1, 2, 'Ramstein AB'),
      makeCell(1, 3, 'Germany'),
      makeCell(1, 4, '60,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.installation).toBe('Ramstein AB');
    expect(result.identities[0]?.location).toBe('Germany');
  });

  it('category code is captured', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Category Code'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'CAT-001'),
      makeCell(1, 1, '17120'),
      makeCell(1, 2, '25,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities[0]?.categoryCode).toBe('17120');
  });

  it('builds V1 artifact from extraction', () => {
    const table = makeTable(0, [
      makeCell(0, 0, 'Project Number'),
      makeCell(0, 1, 'Project Title'),
      makeCell(0, 2, 'Request'),
      makeCell(1, 0, 'ART-001'),
      makeCell(1, 1, 'Test Project'),
      makeCell(1, 2, '42,000'),
    ], 'Cost in Thousands');

    const result = extractC1FromPages({
      pages: [makePage(1, [table])],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    const artifact = buildC1Artifact({
      source: {
        manifestDocumentKey: 'test',
        sourcePdfSha256: 'a'.repeat(64),
        sourceLocator: 's3://test',
        fiscalYear: CYCLE_FY,
        family: 'milcon',
        exhibit: 'C-1',
        authority: 'dod-comptroller',
        component: COMPONENT,
        budgetCycle: 'pb_fy2027',
        documentType: 'pb_exhibit',
      },
      parserRuns: [],
      extraction: result,
      cycleFiscalYear: CYCLE_FY,
    });

    expect(artifact.schemaVersion).toBe('defense_budget_extraction_v1');
    expect(artifact.assertions.length).toBeGreaterThan(0);

    /* Verify the identity assertion is milcon_project */
    const identityAssertion = artifact.assertions.find(
      (a) => a.assertionKind === 'milcon_project',
    );
    expect(identityAssertion).toBeDefined();

    /* Verify the funding assertion is funding */
    const fundingAssertion = artifact.assertions.find(
      (a) => a.assertionKind === 'funding',
    );
    expect(fundingAssertion).toBeDefined();

    /* No canonical writer import */
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'c1-artifact-builder-v1.ts'),
      'utf-8',
    );
    const importLines = source
      .split('\n')
      .filter((l: string) => l.trim().startsWith('import '));
    for (const line of importLines) {
      expect(line).not.toContain('ProgramElementWriterService');
    }
  });
});
