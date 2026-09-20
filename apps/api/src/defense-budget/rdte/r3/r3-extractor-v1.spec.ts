/**
 * r3-extractor-v1.spec — Workstream J tests.
 *
 * Synthetic fixtures for:
 * - named company performing activity;
 * - government organization;
 * - Various/TBD/MIPR;
 * - explicit prime-contractor label;
 * - company-looking name without prime label;
 * - location bleed;
 * - wrapped company/location;
 * - contract method;
 * - missing unit;
 * - project-linked and PE-level rows;
 * - duplicate/conflicting rows;
 * - total-cost not mapped to annual funding.
 */
import type {
  ParserPageResultV1,
  ParsedTableV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { classifyPerformerRole } from './r3-role-classifier.js';
import { normalizePerformerName, r3PerformerNaturalKey } from './r3-performer-normalizer.js';
import { extractR3Performers, type R3PeContextV1 } from './r3-table-extractor-v1.js';

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

function peContext(pageStart: number, pageEnd: number, projectCode?: string): R3PeContextV1 {
  return {
    peCode: PE,
    pageStart,
    pageEnd,
    ...(projectCode != null ? { projectCode } : {}),
  };
}

const headerCells: Cell[] = [
  { rowIndex: 0, columnIndex: 0, text: 'Performing Activity' },
  { rowIndex: 0, columnIndex: 1, text: 'Location' },
  { rowIndex: 0, columnIndex: 2, text: 'Contract Method' },
  { rowIndex: 0, columnIndex: 3, text: 'Total Cost' },
];

/* ------------------------------------------------------------------ */
/* Role classifier                                                     */
/* ------------------------------------------------------------------ */

describe('r3-role-classifier', () => {
  it('defaults company name to PERFORMING_ACTIVITY without prime label', () => {
    const r = classifyPerformerRole({ performerText: 'Lockheed Martin' });
    expect(r.role).toBe('PERFORMING_ACTIVITY');
    expect(r.explicit).toBe(false);
  });

  it('classifies explicit prime contractor', () => {
    const r = classifyPerformerRole({
      performerText: 'Raytheon Company',
      contextText: 'Prime Contractor',
    });
    expect(r.role).toBe('PRIME_CONTRACTOR');
    expect(r.explicit).toBe(true);
  });

  it('classifies government organization as PERFORMING_ACTIVITY', () => {
    const r = classifyPerformerRole({ performerText: 'Army Research Laboratory' });
    expect(r.role).toBe('PERFORMING_ACTIVITY');
    expect(r.explicit).toBe(true);
  });

  it('classifies Various/TBD/MIPR as UNKNOWN', () => {
    expect(classifyPerformerRole({ performerText: 'Various' }).role).toBe('UNKNOWN');
    expect(classifyPerformerRole({ performerText: 'TBD' }).role).toBe('UNKNOWN');
    expect(classifyPerformerRole({ performerText: 'MIPR' }).role).toBe('UNKNOWN');
  });
});

/* ------------------------------------------------------------------ */
/* Performer normalizer                                                */
/* ------------------------------------------------------------------ */

describe('r3-performer-normalizer', () => {
  it('strips corporate suffixes and uppercases', () => {
    expect(normalizePerformerName('Lockheed Martin Inc.')).toBe('LOCKHEED MARTIN');
    expect(normalizePerformerName('Acme Corp.')).toBe('ACME');
    expect(normalizePerformerName('Foo LLC')).toBe('FOO');
  });

  it('collapses whitespace', () => {
    expect(normalizePerformerName('  Foo   Bar  ')).toBe('FOO BAR');
  });

  it('builds stable natural keys', () => {
    const k1 = r3PerformerNaturalKey({
      peCode: PE,
      performerNormalized: 'ACME',
      location: 'Huntsville, AL',
      contractMethod: 'C/CPFF',
      costCategory: 'Product Development',
      fiscalYear: 2027,
    });
    const k2 = r3PerformerNaturalKey({
      peCode: PE,
      performerNormalized: 'ACME',
      location: 'Huntsville, AL',
      contractMethod: 'C/CPFF',
      costCategory: 'Product Development',
      fiscalYear: 2027,
    });
    expect(k1).toBe(k2);
  });
});

/* ------------------------------------------------------------------ */
/* Table extractor                                                     */
/* ------------------------------------------------------------------ */

describe('r3-table-extractor-v1', () => {
  it('extracts named company performing activity', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Lockheed Martin' },
      { rowIndex: 1, columnIndex: 1, text: 'Bethesda, MD' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '12.500' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: 2027,
    });

    expect(result.performers).toHaveLength(1);
    expect(result.performers[0]?.performerName).toBe('Lockheed Martin');
    expect(result.performers[0]?.performerNormalized).toBe('LOCKHEED MARTIN');
    expect(result.performers[0]?.performerRole).toBe('PERFORMING_ACTIVITY');
    expect(result.performers[0]?.location).toBe('Bethesda, MD');
    expect(result.performers[0]?.contractMethod).toBe('C/CPFF');
    expect(result.performers[0]?.totalCost?.originalValue).toBe('12.5');
    expect(result.performers[0]?.totalCost?.originalUnit).toBe('millions');
  });

  it('extracts government organization', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Army Research Laboratory' },
      { rowIndex: 1, columnIndex: 1, text: 'Adelphi, MD' },
      { rowIndex: 1, columnIndex: 2, text: 'In-House' },
      { rowIndex: 1, columnIndex: 3, text: '3.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.performerRole).toBe('PERFORMING_ACTIVITY');
    expect(result.performers[0]?.roleExplicit).toBe(true);
  });

  it('handles Various/TBD/MIPR as UNKNOWN', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Various' },
      { rowIndex: 1, columnIndex: 1, text: 'Multiple' },
      { rowIndex: 1, columnIndex: 2, text: 'MIPR' },
      { rowIndex: 1, columnIndex: 3, text: '1.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.performerRole).toBe('UNKNOWN');
  });

  it('promotes to PRIME_CONTRACTOR only with explicit label', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Performing Activity' },
      { rowIndex: 0, columnIndex: 1, text: 'Location' },
      { rowIndex: 0, columnIndex: 2, text: 'Contract Method' },
      { rowIndex: 0, columnIndex: 3, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: 'Raytheon Company (Prime Contractor)' },
      { rowIndex: 1, columnIndex: 1, text: 'Tucson, AZ' },
      { rowIndex: 1, columnIndex: 2, text: 'FFP' },
      { rowIndex: 1, columnIndex: 3, text: '25.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.performerRole).toBe('PRIME_CONTRACTOR');
  });

  it('does not promote company-looking name without prime label', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Boeing Company' },
      { rowIndex: 1, columnIndex: 1, text: 'Seattle, WA' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '10.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.performerRole).toBe('PERFORMING_ACTIVITY');
    expect(result.performers[0]?.roleExplicit).toBe(false);
  });

  it('captures contract method', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPIF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.contractMethod).toBe('C/CPIF');
  });

  it('omits cost when unit is missing', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.totalCost).toBeUndefined();
    expect(result.omissions.some((o) => o.reason === 'missing_unit')).toBe(true);
  });

  it('links project from PE context', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1, 'A1'),
    });

    expect(result.performers[0]?.projectCode).toBe('A1');
  });

  it('extracts PE-level rows without project', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.projectCode).toBeUndefined();
  });

  it('dedupes exact duplicate rows', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
      { rowIndex: 2, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 2, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 2, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 2, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: 2027,
    });

    expect(result.performers).toHaveLength(1);
  });

  it('detects conflicting performer names under same natural key', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Cost Category Item' },
      { rowIndex: 0, columnIndex: 1, text: 'Contract Method & Type' },
      { rowIndex: 0, columnIndex: 2, text: 'Performing Activity & Location' },
      { rowIndex: 0, columnIndex: 3, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: 'Integration Support' },
      { rowIndex: 1, columnIndex: 1, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 2, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
      { rowIndex: 2, columnIndex: 0, text: 'Integration Support' },
      { rowIndex: 2, columnIndex: 1, text: 'C/CPFF' },
      { rowIndex: 2, columnIndex: 2, text: 'ACME INC.' },
      { rowIndex: 2, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: 2027,
    });

    /* Identical row identity plus a different raw name remains a conflict. */
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.reason).toBe('conflicting_performer_name');
    expect(result.performers).toHaveLength(1);
  });

  it('keeps the distinct PE 0604020A page 399 rows keyed by Cost Category Item', () => {
    /*
     * FY2024 Army BA4A physical PDF page 399 (printed Volume 2a - 357)
     * contains two legitimate Management Services rows with generic performer
     * text that differs only by terminal punctuation. Their financial row
     * identity comes from Cost Category Item; collapsing that header into the
     * generic cost role creates the production r3_duplicate_natural_key_conflict.
     */
    const sourceRows = [
      [
        'Cost Category Item',
        'Contract\nMethod\n& Type',
        'Performing\nActivity & Location',
        'Prior\nYears',
        'Cost',
        'Award\nDate',
        'Cost',
        '',
        'Award\nDate',
        'Cost',
        'Award\nDate',
        'Cost',
        'Award\nDate',
        'Cost',
        '',
        'Cost To\nComplete',
        'Total\nCost',
        'Target\nValue of\nContract',
      ],
      [
        'Olympus: Program\nManagement and\nCapability Transition',
        'TBD',
        'Various : Various',
        '-',
        '-',
        '',
        '6.178',
        '',
        '',
        '-',
        '',
        '-',
        '',
        '-',
        '',
        '0.000',
        '6.178',
        '-',
      ],
      [
        'SBIR & STTR Adjustment',
        'TBD',
        'Various : Various.',
        '-',
        '-',
        '',
        '2.811',
        '',
        '',
        '-',
        '',
        '-',
        '',
        '-',
        '',
        '0.000',
        '2.811',
        '-',
      ],
    ];
    const cells: Cell[] = sourceRows.flatMap((row, rowIndex) =>
      row.map((text, columnIndex) => ({ rowIndex, columnIndex, text })),
    );
    const page = makePage(
      [makeTable(cells)],
      399,
      'Exhibit R-3, RDT&E Project Cost Analysis: PB 2024 Army $ in Millions',
      'Volume 2a - 357',
    );
    const result = extractR3Performers({
      pages: [page],
      peContext: { peCode: '0604020A', pageStart: 399, pageEnd: 399 },
      cycleFiscalYear: 2024,
    });

    expect(result.conflicts).toEqual([]);
    expect(result.performers).toHaveLength(2);
    expect(result.performers.map((row) => row.costCategory)).toEqual([
      'Olympus: Program\nManagement and\nCapability Transition',
      'SBIR & STTR Adjustment',
    ]);
    expect(result.performers.map((row) => row.totalCost?.valueMillions)).toEqual([
      '6.178',
      '2.811',
    ]);
    expect(result.performers.map((row) => row.fiscalYear)).toEqual([2024, 2024]);
    expect(result.omissions.filter((row) => row.reason === 'invalid_cost_number')).toEqual([]);
    expect(new Set(result.performers.map((row) => row.naturalKey)).size).toBe(2);
  });

  it('selects the exact Total Cost column instead of an annual cost column', () => {
    const cells: Cell[] = [
      { rowIndex: 0, columnIndex: 0, text: 'Performing Activity' },
      { rowIndex: 0, columnIndex: 1, text: 'FY 2023 Cost' },
      { rowIndex: 0, columnIndex: 2, text: 'Total Cost' },
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: '1.250' },
      { rowIndex: 1, columnIndex: 2, text: '9.750' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers[0]?.totalCost?.valueMillions).toBe('9.75');
  });

  it('never maps total cost to annual funding fields', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    const p = result.performers[0]!;
    /* totalCost is a cost-analysis fact only — no request/enacted/executed. */
    expect(p.totalCost).toBeDefined();
    expect((p as unknown as Record<string, unknown>).request).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).enacted).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).executed).toBeUndefined();
    expect((p as unknown as Record<string, unknown>).disposition).toBeUndefined();
  });

  it('does not process non-R-3 pages', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-2 Budget Item Justification');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
    });

    expect(result.performers).toHaveLength(0);
    expect(result.tableDetected).toBe(false);
  });

  it('retains distinct rows that differ on location', () => {
    const cells: Cell[] = [
      ...headerCells,
      { rowIndex: 1, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 1, columnIndex: 1, text: 'Huntsville, AL' },
      { rowIndex: 1, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 1, columnIndex: 3, text: '4.000' },
      { rowIndex: 2, columnIndex: 0, text: 'Acme Inc' },
      { rowIndex: 2, columnIndex: 1, text: 'Orlando, FL' },
      { rowIndex: 2, columnIndex: 2, text: 'C/CPFF' },
      { rowIndex: 2, columnIndex: 3, text: '2.000' },
    ];
    const page = makePage([makeTable(cells)], 1, 'R-3 RDT&E Cost Analysis $ in Millions');
    const result = extractR3Performers({
      pages: [page],
      peContext: peContext(1, 1),
      cycleFiscalYear: 2027,
    });

    expect(result.performers).toHaveLength(2);
  });
});
