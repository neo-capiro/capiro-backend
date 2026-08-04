/**
 * r4-extractor-v1.spec — Workstream K tests.
 *
 * Synthetic fixtures for:
 * - exact date;
 * - month/year;
 * - 3Q FY2028;
 * - FY-only period;
 * - date range;
 * - text-only schedule;
 * - conflicting periods;
 * - milestone without parent PE;
 * - project-linked milestone;
 * - no fabricated date.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { parseR4SchedulePeriod, hasExactDate, exactDateString } from './r4-schedule-period-v1.js';
import {
  extractR4Milestones,
  buildR4MilestoneAssertions,
  evaluateR4ManifestPolicy,
  type R4PeContextV1,
} from './r4-extractor-v1.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

const PE = '0601234A';

type Cell = { rowIndex: number; columnIndex: number; text: string };

function makeTable(cells: Cell[], tableIndex = 0): ParsedTableV1 {
  const maxRow = Math.max(...cells.map((c) => c.rowIndex), 0);
  const maxCol = Math.max(...cells.map((c) => c.columnIndex), 0);
  return {
    tableIndex,
    rowCount: maxRow + 1,
    columnCount: maxCol + 1,
    cells: cells.map((c) => ({
      rowIndex: c.rowIndex,
      columnIndex: c.columnIndex,
      text: c.text,
    })),
    warnings: [],
  };
}

function makePage(
  tables: ParsedTableV1[],
  page: number,
  headerText?: string,
  printedPage?: string,
): ParserPageResultV1 {
  return {
    page,
    ...(printedPage != null ? { printedPage } : {}),
    ...(headerText != null ? { text: headerText } : {}),
    blocks:
      headerText != null ? [{ blockIndex: 0, blockType: 'header' as const, text: headerText }] : [],
    tables,
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function peContext(pageStart: number, pageEnd: number, projectCode?: string): R4PeContextV1 {
  return {
    peCode: PE,
    pageStart,
    pageEnd,
    ...(projectCode != null ? { projectCode } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Schedule period parser tests                                        */
/* ------------------------------------------------------------------ */

describe('r4-schedule-period-v1', () => {
  it('parses exact ISO date', () => {
    const p = parseR4SchedulePeriod('2027-01-15');
    expect(p.kind).toBe('exact_date');
    expect(p.exactDate).toBe('2027-01-15');
    expect(p.year).toBe(2027);
    expect(p.month).toBe(1);
    expect(hasExactDate(p)).toBe(true);
    expect(exactDateString(p)).toBe('2027-01-15');
  });

  it('parses exact US date', () => {
    const p = parseR4SchedulePeriod('1/15/2027');
    expect(p.kind).toBe('exact_date');
    expect(p.exactDate).toBe('2027-01-15');
  });

  it('parses exact month-name date', () => {
    const p = parseR4SchedulePeriod('Jan 15, 2027');
    expect(p.kind).toBe('exact_date');
    expect(p.exactDate).toBe('2027-01-15');
  });

  it('parses month/year without fabricating day', () => {
    const p = parseR4SchedulePeriod('Jan 2027');
    expect(p.kind).toBe('calendar_month');
    expect(p.year).toBe(2027);
    expect(p.month).toBe(1);
    expect(p.exactDate).toBeUndefined();
    expect(hasExactDate(p)).toBe(false);
    expect(exactDateString(p)).toBeUndefined();
  });

  it('parses 3Q FY2028 as fiscal_quarter', () => {
    const p = parseR4SchedulePeriod('3Q FY2028');
    expect(p.kind).toBe('fiscal_quarter');
    expect(p.fiscalYear).toBe(2028);
    expect(p.fiscalQuarter).toBe(3);
    expect(p.exactDate).toBeUndefined();
  });

  it('parses Q3 FY28 as fiscal_quarter', () => {
    const p = parseR4SchedulePeriod('Q3 FY28');
    expect(p.kind).toBe('fiscal_quarter');
    expect(p.fiscalYear).toBe(2028);
    expect(p.fiscalQuarter).toBe(3);
  });

  it('parses FY-only period', () => {
    const p = parseR4SchedulePeriod('FY 2028');
    expect(p.kind).toBe('fiscal_year');
    expect(p.fiscalYear).toBe(2028);
    expect(p.exactDate).toBeUndefined();
  });

  it('parses FY28 with 2-digit year', () => {
    const p = parseR4SchedulePeriod('FY28');
    expect(p.kind).toBe('fiscal_year');
    expect(p.fiscalYear).toBe(2028);
  });

  it('parses date range', () => {
    const p = parseR4SchedulePeriod('Jan 2027 – Jun 2028');
    expect(p.kind).toBe('range');
    expect(p.start?.kind).toBe('calendar_month');
    expect(p.start?.year).toBe(2027);
    expect(p.start?.month).toBe(1);
    expect(p.end?.kind).toBe('calendar_month');
    expect(p.end?.year).toBe(2028);
    expect(p.end?.month).toBe(6);
    expect(p.exactDate).toBeUndefined();
  });

  it('parses FY range', () => {
    const p = parseR4SchedulePeriod('FY2027-FY2028');
    expect(p.kind).toBe('range');
    expect(p.start?.fiscalYear).toBe(2027);
    expect(p.end?.fiscalYear).toBe(2028);
  });

  it('parses text-only schedule', () => {
    const p = parseR4SchedulePeriod('TBD');
    expect(p.kind).toBe('text_only');
    expect(p.textLabel).toBe('TBD');
    expect(p.exactDate).toBeUndefined();
  });

  it('parses empty string as unknown', () => {
    const p = parseR4SchedulePeriod('');
    expect(p.kind).toBe('unknown');
    expect(p.confidence).toBe(0);
  });

  it('parses calendar quarter', () => {
    const p = parseR4SchedulePeriod('Q3 2027');
    expect(p.kind).toBe('calendar_quarter');
    expect(p.year).toBe(2027);
    expect(p.calendarQuarter).toBe(3);
  });

  it('never fabricates dates from quarter/year labels', () => {
    const fq = parseR4SchedulePeriod('3Q FY2028');
    expect(fq.exactDate).toBeUndefined();
    const fy = parseR4SchedulePeriod('FY2028');
    expect(fy.exactDate).toBeUndefined();
    const cm = parseR4SchedulePeriod('Jan 2027');
    expect(cm.exactDate).toBeUndefined();
  });

  it('parses bare year as fiscal_year', () => {
    const p = parseR4SchedulePeriod('2027');
    expect(p.kind).toBe('fiscal_year');
    expect(p.fiscalYear).toBe(2027);
  });
});

/* ------------------------------------------------------------------ */
/* Extractor tests                                                     */
/* ------------------------------------------------------------------ */

describe('r4-extractor-v1', () => {
  const headerCells: Cell[] = [
    { rowIndex: 0, columnIndex: 0, text: 'Milestone' },
    { rowIndex: 0, columnIndex: 1, text: 'Planned Date' },
    { rowIndex: 0, columnIndex: 2, text: 'Actual Date' },
    { rowIndex: 0, columnIndex: 3, text: 'Status' },
    { rowIndex: 0, columnIndex: 4, text: 'Notes' },
  ];

  it('extracts milestone with exact date', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Critical Design Review' },
      { rowIndex: 1, columnIndex: 1, text: '2027-03-15' },
      { rowIndex: 1, columnIndex: 2, text: '' },
      { rowIndex: 1, columnIndex: 3, text: 'On Track' },
      { rowIndex: 1, columnIndex: 4, text: '' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0]?.milestoneType).toBe('Critical Design Review');
    expect(result.milestones[0]?.plannedPeriod.kind).toBe('exact_date');
    expect(result.milestones[0]?.plannedPeriod.exactDate).toBe('2027-03-15');
    expect(result.milestones[0]?.status).toBe('On Track');
  });

  it('extracts milestone with month/year period', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Prototype Delivery' },
      { rowIndex: 1, columnIndex: 1, text: 'Jan 2027' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.kind).toBe('calendar_month');
    expect(result.milestones[0]?.plannedPeriod.exactDate).toBeUndefined();
  });

  it('extracts milestone with fiscal quarter period', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Initial Operational Capability' },
      { rowIndex: 1, columnIndex: 1, text: '3Q FY2028' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.kind).toBe('fiscal_quarter');
    expect(result.milestones[0]?.plannedPeriod.fiscalYear).toBe(2028);
    expect(result.milestones[0]?.plannedPeriod.fiscalQuarter).toBe(3);
    expect(result.milestones[0]?.plannedPeriod.exactDate).toBeUndefined();
  });

  it('extracts milestone with FY-only period', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Full Rate Production' },
      { rowIndex: 1, columnIndex: 1, text: 'FY 2030' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.kind).toBe('fiscal_year');
    expect(result.milestones[0]?.plannedPeriod.fiscalYear).toBe(2030);
  });

  it('extracts milestone with date range', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Development Testing' },
      { rowIndex: 1, columnIndex: 1, text: 'Jan 2027 – Jun 2028' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.kind).toBe('range');
    expect(result.milestones[0]?.plannedPeriod.start?.year).toBe(2027);
    expect(result.milestones[0]?.plannedPeriod.end?.year).toBe(2028);
  });

  it('extracts milestone with text-only schedule', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Follow-on Contract' },
      { rowIndex: 1, columnIndex: 1, text: 'TBD' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.kind).toBe('text_only');
    expect(result.milestones[0]?.plannedPeriod.textLabel).toBe('TBD');
  });

  it('extracts actual period when present', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'PDR' },
      { rowIndex: 1, columnIndex: 1, text: '2027-01-15' },
      { rowIndex: 1, columnIndex: 2, text: '2027-02-01' },
      { rowIndex: 1, columnIndex: 3, text: 'Complete' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones[0]?.plannedPeriod.exactDate).toBe('2027-01-15');
    expect(result.milestones[0]?.actualPeriod?.exactDate).toBe('2027-02-01');
  });

  it('extracts project-linked milestone', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Project Alpha CDR' },
      { rowIndex: 1, columnIndex: 1, text: 'Q2 FY2027' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1, 'ALPHA'),
    });

    expect(result.milestones[0]?.projectCode).toBe('Alpha');
  });

  it('omits milestone with missing planned date', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Some Milestone' },
      { rowIndex: 1, columnIndex: 1, text: ' ' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'missing_planned_date')).toBe(true);
  });

  it('omits milestone with missing type', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: '' },
      { rowIndex: 1, columnIndex: 1, text: '2027-01-15' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-4 RDT&E Schedule Profile');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'missing_milestone_type')).toBe(true);
  });

  it('does not process non-R-4 pages', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Milestone' },
      { rowIndex: 1, columnIndex: 1, text: '2027-01-15' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-2 Budget Item Justification');
    const result = extractR4Milestones({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.milestones).toHaveLength(0);
    expect(result.tableDetected).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Assertion builder tests                                             */
/* ------------------------------------------------------------------ */

describe('buildR4MilestoneAssertions', () => {
  it('populates plannedDate only for exact dates', () => {
    const assertions = buildR4MilestoneAssertions({
      milestones: [
        {
          parentPeCode: PE,
          milestoneType: 'CDR',
          plannedPeriod: parseR4SchedulePeriod('2027-01-15'),
          page: 1,
          tableIndex: 0,
          rowIndex: 1,
          rawCells: [],
        },
        {
          parentPeCode: PE,
          milestoneType: 'IOC',
          plannedPeriod: parseR4SchedulePeriod('3Q FY2028'),
          page: 1,
          tableIndex: 0,
          rowIndex: 2,
          rawCells: [],
        },
      ],
      assertionIdPrefix: 'test_assert',
      sourceFactIdPrefix: 'test_fact',
      evidenceIdPrefix: 'test_ev',
    });

    expect(assertions).toHaveLength(2);
    expect(assertions[0]?.plannedDate).toBe('2027-01-15');
    expect(assertions[1]?.plannedDate).toBeUndefined();
  });

  it('populates actualDate only for exact dates', () => {
    const assertions = buildR4MilestoneAssertions({
      milestones: [
        {
          parentPeCode: PE,
          milestoneType: 'PDR',
          plannedPeriod: parseR4SchedulePeriod('2027-01-15'),
          actualPeriod: parseR4SchedulePeriod('FY 2027'),
          page: 1,
          tableIndex: 0,
          rowIndex: 1,
          rawCells: [],
        },
      ],
      assertionIdPrefix: 'test_assert',
      sourceFactIdPrefix: 'test_fact',
      evidenceIdPrefix: 'test_ev',
    });

    expect(assertions[0]?.plannedDate).toBe('2027-01-15');
    expect(assertions[0]?.actualDate).toBeUndefined(); // FY 2027 is not exact
  });

  it('retains project code and structured period metadata on assertions', () => {
    const assertions = buildR4MilestoneAssertions({
      milestones: [
        {
          parentPeCode: PE,
          projectCode: 'A1',
          milestoneType: 'CDR',
          plannedPeriod: parseR4SchedulePeriod('3Q FY2028'),
          page: 4,
          printedPage: 'R-4-12',
          tableIndex: 0,
          rowIndex: 3,
          rawCells: [],
        },
      ],
      assertionIdPrefix: 'test_assert',
      sourceFactIdPrefix: 'test_fact',
      evidenceIdPrefix: 'test_ev',
    });

    const a = assertions[0]!;
    /* Project linkage survives onto the assertion. */
    expect((a as Record<string, unknown>)['projectCode']).toBe('A1');
    /* No fabricated exact date for a fiscal quarter. */
    expect(a.plannedDate).toBeUndefined();
    /* Structured period fidelity travels in metadata. */
    const metadata = a.metadata as Record<string, unknown>;
    expect(metadata).toBeDefined();
    const planned = metadata['plannedPeriod'] as Record<string, unknown>;
    expect(planned['kind']).toBe('fiscal_quarter');
    expect(planned['fiscalYear']).toBe(2028);
    expect(planned['fiscalQuarter']).toBe(3);
    expect(planned['rawText']).toBe('3Q FY2028');
    expect(metadata['physicalPage']).toBe(4);
    expect(metadata['printedPage']).toBe('R-4-12');
    expect(metadata['rowIndex']).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* Manifest policy tests                                               */
/* ------------------------------------------------------------------ */

describe('evaluateR4ManifestPolicy', () => {
  it('required blocks certification', () => {
    const result = evaluateR4ManifestPolicy({ policy: 'required' });
    expect(result.blocksCertification).toBe(true);
  });

  it('optional does not block certification', () => {
    const result = evaluateR4ManifestPolicy({ policy: 'optional' });
    expect(result.blocksCertification).toBe(false);
  });

  it('not_applicable does not block certification with reason', () => {
    const result = evaluateR4ManifestPolicy({
      policy: 'not_applicable',
      reason: 'No R-4 published for FY2027',
    });
    expect(result.blocksCertification).toBe(false);
    expect(result.reason).toBe('No R-4 published for FY2027');
  });
});
