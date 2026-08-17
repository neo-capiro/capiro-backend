/**
 * Phase 5 Workstream K tests — DD1391 (MILCON project justification)
 * extraction.
 */
import { extractDd1391FromPages } from './dd1391-extractor-v1.js';
import { buildDd1391Artifact } from './dd1391-artifact-builder-v1.js';
import type {
  ParserPageResultV1,
  ParsedTableV1,
  ParsedTableCellV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { BudgetComponentV1 } from '../../contracts/extraction-artifact-v1.js';

const CYCLE_FY = 2027;
const COMPONENT: BudgetComponentV1 = 'ARMY';
const ACCOUNT = 'Military Construction, Army';

function makeCell(
  rowIndex: number,
  columnIndex: number,
  text: string,
  confidence?: string,
): ParsedTableCellV1 {
  return {
    rowIndex,
    columnIndex,
    text,
    ...(confidence != null ? { confidence } : {}),
  };
}

function makeTable(tableIndex: number, cells: ParsedTableCellV1[], label?: string): ParsedTableV1 {
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
  confidence?: string,
): ParserPageResultV1 {
  return {
    page,
    blocks: [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
    ...(text != null ? { text } : {}),
    ...(confidence != null ? { confidence } : {}),
  };
}

const DD1391_TEXT = `
DD Form 1391
Project No.: ABC-12345
Project Title: New Barracks Construction
Installation: Fort Bragg, NC
Category Code: 17120
Cost in Thousands

Requirement: This project provides new barracks for 500 personnel.
Current Situation: Existing barracks are over 50 years old and substandard.
Impact if not provided: Continued degradation of living conditions.
`;

describe('dd1391-extractor-v1', () => {
  it('extracts digital DD1391 with project identity and narratives', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '30,000'),
        makeCell(2, 0, 'Contingency'),
        makeCell(2, 1, '3,000'),
        makeCell(3, 0, 'Total Request'),
        makeCell(3, 1, '33,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.printedProjectCode).toBe('ABC-12345');
    expect(result.identities[0]?.projectTitle).toBe('New Barracks Construction');
    expect(result.identities[0]?.installation).toBe('Fort Bragg, NC');
    expect(result.identities[0]?.categoryCode).toBe('17120');
    expect(result.identities[0]?.identity.lineKind).toBe('MILCON_PROJECT');

    /* Cost categories remain separate */
    expect(result.costs).toHaveLength(3);
    const categories = result.costs.map((c) => c.costCategory).sort();
    expect(categories).toEqual(['contingency', 'primary_facility', 'total_request']);

    /* Narratives are extracted */
    expect(result.narratives.length).toBeGreaterThanOrEqual(3);
    const sectionTypes = result.narratives.map((n) => n.sectionType);
    expect(sectionTypes).toContain('requirement');
    expect(sectionTypes).toContain('current_situation');
    expect(sectionTypes).toContain('impact');
  });

  it('multiple cost categories are separate facts', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '20,000'),
        makeCell(2, 0, 'Supporting Facilities'),
        makeCell(2, 1, '5,000'),
        makeCell(3, 0, 'Contingency'),
        makeCell(3, 1, '2,500'),
        makeCell(4, 0, 'S&I/Overhead'),
        makeCell(4, 1, '1,500'),
        makeCell(5, 0, 'Design'),
        makeCell(5, 1, '1,000'),
        makeCell(6, 0, 'Total Request'),
        makeCell(6, 1, '30,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.costs).toHaveLength(6);
    /* No cost category is silently dropped */
    const cats = result.costs.map((c) => c.costCategory);
    expect(cats).toContain('primary_facility');
    expect(cats).toContain('supporting_facilities');
    expect(cats).toContain('contingency');
    expect(cats).toContain('supervision_inspection_overhead');
    expect(cats).toContain('design');
    expect(cats).toContain('total_request');
  });

  it('missing location/project number is blocking omission', () => {
    const textWithoutProject = `
DD Form 1391
Project Title: New Construction
Installation: Fort Hood, TX
`;
    const result = extractDd1391FromPages({
      pages: [makePage(1, [], textWithoutProject)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.severity).toBe('blocking');
  });

  it('OCR low-confidence value requires review', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '30,000'),
        makeCell(2, 0, 'Total Request'),
        makeCell(2, 1, '30,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT, '0.75')],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
      ocrConfidenceThreshold: 0.85,
    });

    expect(result.ocrConfidence).toHaveLength(1);
    expect(result.ocrConfidence[0]?.requiresReview).toBe(true);
  });

  it('schedule dates are extracted', () => {
    const textWithSchedule = `
DD Form 1391
Project No.: SCH-001
Project Title: Scheduled Project
Installation: Fort Bliss, TX
Acquisition Date: Q1 FY2027
Start Date: Q3 FY2027
Completion: Q4 FY2028
`;
    const result = extractDd1391FromPages({
      pages: [makePage(1, [], textWithSchedule)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.schedules.length).toBeGreaterThanOrEqual(2);
    const milestones = result.schedules.map((s) => s.milestone);
    expect(milestones).toContain('acquisition_award');
    expect(milestones).toContain('construction_start');
    expect(milestones).toContain('completion');
  });

  it('requirement, current situation, and impact narratives are extracted', () => {
    const text = `
DD Form 1391
Project No.: NAR-001
Project Title: Narrative Test
Installation: Fort Drum, NY
Requirement: New facility needed for training.
Current Situation: No suitable facility exists.
Impact if not provided: Training capability degraded.
`;
    const result = extractDd1391FromPages({
      pages: [makePage(1, [], text)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.narratives.length).toBe(3);
    const req = result.narratives.find((n) => n.sectionType === 'requirement');
    expect(req?.text).toContain('New facility needed');
    const cur = result.narratives.find((n) => n.sectionType === 'current_situation');
    expect(cur?.text).toContain('No suitable facility');
    const imp = result.narratives.find((n) => n.sectionType === 'impact');
    expect(imp?.text).toContain('Training capability degraded');
  });

  it('total arithmetic passes when sum equals total', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '30,000'),
        makeCell(2, 0, 'Contingency'),
        makeCell(2, 1, '3,000'),
        makeCell(3, 0, 'Total Request'),
        makeCell(3, 1, '33,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.totalArithmetic.applicable).toBe(true);
    expect(result.totalArithmetic.passed).toBe(true);
  });

  it('total arithmetic fails when sum does not equal total', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '30,000'),
        makeCell(2, 0, 'Contingency'),
        makeCell(2, 1, '3,000'),
        makeCell(3, 0, 'Total Request'),
        makeCell(3, 1, '50,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.totalArithmetic.applicable).toBe(true);
    expect(result.totalArithmetic.passed).toBe(false);
  });

  it('funding values are extracted from page text', () => {
    const text = `
DD Form 1391
Project No.: FND-001
Project Title: Funding Test
Installation: Fort Carson, CO
Request Amount: $45,000
Authorization Amount: $42,000
`;
    const result = extractDd1391FromPages({
      pages: [makePage(1, [], text)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.funding).toHaveLength(2);
    const request = result.funding.find((f) => f.fundingType === 'request');
    expect(request).toBeDefined();
    expect(request?.originalValue).toBe('45000');
    const auth = result.funding.find((f) => f.fundingType === 'authorization');
    expect(auth).toBeDefined();
    expect(auth?.originalValue).toBe('42000');
  });

  it('multi-page form is segmented by identity', () => {
    const page1Text = `
DD Form 1391
Project No.: MUL-001
Project Title: Multi-Page Project
Installation: Fort Polk, LA
Requirement: Multi-page test.
`;
    const page2Text = `
Current Situation: Continued from page 1.
Impact if not provided: Impact text.
`;
    const result = extractDd1391FromPages({
      pages: [makePage(1, [], page1Text), makePage(2, [], page2Text)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    expect(result.identities).toHaveLength(1);
    expect(result.narratives.length).toBeGreaterThanOrEqual(3);
  });

  it('builds V1 artifact from extraction', () => {
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '30,000'),
        makeCell(2, 0, 'Contingency'),
        makeCell(2, 1, '3,000'),
        makeCell(3, 0, 'Total Request'),
        makeCell(3, 1, '33,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], DD1391_TEXT)],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
    });

    const artifact = buildDd1391Artifact({
      source: {
        manifestDocumentKey: 'test',
        sourcePdfSha256: 'a'.repeat(64),
        sourceLocator: 's3://test',
        fiscalYear: CYCLE_FY,
        family: 'milcon',
        exhibit: 'DD1391',
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

    const identityAssertion = artifact.assertions.find((a) => a.assertionKind === 'milcon_project');
    expect(identityAssertion).toBeDefined();

    /* No canonical writer import */
    const source = require('fs').readFileSync(
      require('path').join(__dirname, 'dd1391-artifact-builder-v1.ts'),
      'utf-8',
    );
    const importLines = source.split('\n').filter((l: string) => l.trim().startsWith('import '));
    for (const line of importLines) {
      expect(line).not.toContain('ProgramElementWriterService');
    }
  });

  it('scanned/rotated form fixture with OCR confidence', () => {
    const text = `
DD Form 1391
Project No.: SCAN-001
Project Title: Scanned Form Test
Installation: Fort Riley, KS
`;
    const costTable = makeTable(
      0,
      [
        makeCell(0, 0, 'Cost Category'),
        makeCell(0, 1, 'Amount'),
        makeCell(1, 0, 'Primary Facility'),
        makeCell(1, 1, '25,000'),
        makeCell(2, 0, 'Total Request'),
        makeCell(2, 1, '25,000'),
      ],
      'Cost in Thousands',
    );

    const result = extractDd1391FromPages({
      pages: [makePage(1, [costTable], text, '0.65')],
      cycleFiscalYear: CYCLE_FY,
      component: COMPONENT,
      account: ACCOUNT,
      ocrConfidenceThreshold: 0.8,
    });

    expect(result.ocrConfidence).toHaveLength(1);
    expect(result.ocrConfidence[0]?.minValueConfidence).toBe(0.65);
    expect(result.ocrConfidence[0]?.requiresReview).toBe(true);
  });
});
