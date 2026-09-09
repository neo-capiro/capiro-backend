/**
 * Phase 10B-35 regression -- R-2A project identity must never leak across a
 * PE / exhibit boundary.
 *
 * Defect (production candidate 5522ea3b-203f-5eaa-91b2-157422121b66, FY2024
 * Army RDT&E R-2 Vol 1 BA1, physical pages 126 / 132 / 161 / 164): the first
 * Exhibit R-2 PE-summary page of PEs 0601103A / 0601104A / 0601121A / 0601601A
 * carries no R-2A marker, so `groupR2aPagesByStructuralIdentityV1` treated it
 * as a header-less continuation of the PREVIOUS PE's last R-2A project section
 * (T14 / D58 / J13 / CB5). Every FY2025-FY2028 figure in that page's cost
 * table -- including the PE "Total Program Element" row -- was then asserted
 * as `project_funding` of the wrong PE and wrong project (32 of the 108
 * flagged monetary assertions in the production artifact).
 *
 * Repair under test:
 *   1. a page that carries a PE-level exhibit header (Exhibit R-2 marker,
 *      "RDT&E Budget Item Justification", or a self-labelled
 *      "R-1 Program Element (Number/Name)" cell with no project cell) is an
 *      explicit `exhibit_boundary`: it closes any open project section and
 *      is never inherited;
 *   2. any other non-R-2A exhibit marker (R-3, R-4, R-4A, ...) is likewise a
 *      boundary;
 *   3. header-less continuation inheritance is valid only for the physically
 *      adjacent next page of an open section;
 *   4. defence in depth: a "Total Program Element" row inside a project
 *      funding table is never a project row -- it fails closed with the
 *      explicit omission reason `pe_total_row_in_project_table`.
 *
 * Fixtures: the real SHA-pinned 170-page raw parser output (every one of the
 * four real transitions) plus generic synthetic controls with different
 * identifiers and page positions so the assertion is about structure, not
 * about this one document.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type {
  LayoutBlockV1,
  ParsedTableV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { parseParserRuntimeResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { extractR2aProjectFunding } from './r2a-project-funding-extractor-v1.js';
import { extractR2aProjectsFromPages } from './r2a-project-extractor-v1.js';
import {
  extractR2aStructuralHeaderV1,
  groupR2aPagesByStructuralIdentityV1,
} from './r2a-structural-project-header-parser-v1.js';

/** Structural (not imported) so this spec also compiles against the pre-fix
 * module and fails on BEHAVIOUR there -- that is the RED half of the proof. */
type BoundaryLike = { page: number; kind: string; peCode?: string; peTitle?: string };
function boundariesOf(grouping: unknown): BoundaryLike[] {
  return ((grouping as { boundaries?: BoundaryLike[] }).boundaries ?? []) as BoundaryLike[];
}
function kindOf(result: unknown): string | undefined {
  return (result as { kind?: string }).kind;
}

/* ------------------------------------------------------------------ */
/* Real fixture                                                        */
/* ------------------------------------------------------------------ */

const REAL_FIXTURE_SHA = '1fb7402152d0ec6ca536e20ac8d3ed8e7da61951ee691d1d05388abb4c462ab6';

function readRealFixturePages(): ParserPageResultV1[] {
  const fixturePath = join(
    __dirname,
    '..',
    'cycle',
    '__fixtures__',
    'production-fy2024-army-r2-raw-parser-output-170pages.json',
  );
  if (!existsSync(fixturePath)) throw new Error(`missing real fixture: ${fixturePath}`);
  const parsed = parseParserRuntimeResultV1(JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown);
  if (parsed.inputSourceSha256 !== REAL_FIXTURE_SHA) {
    throw new Error(`real fixture source SHA drifted: expected ${REAL_FIXTURE_SHA}, got ${parsed.inputSourceSha256}`);
  }
  return parsed.pages as ParserPageResultV1[];
}

/** The four real transitions (first R-2 page of the next PE) and the
 * project the pre-fix grouper leaked onto each of them. */
const REAL_TRANSITIONS = [
  { r2Pages: [126, 127], newPe: '0601103A', leakedFrom: { parentPeCode: '0601102A', projectCode: 'T14', pages: [123, 124, 125] } },
  { r2Pages: [132, 133, 134], newPe: '0601104A', leakedFrom: { parentPeCode: '0601103A', projectCode: 'D58', pages: [131] } },
  { r2Pages: [161], newPe: '0601121A', leakedFrom: { parentPeCode: '0601104A', projectCode: 'J13', pages: [159, 160] } },
  { r2Pages: [164, 165], newPe: '0601601A', leakedFrom: { parentPeCode: '0601121A', projectCode: 'CB5', pages: [162, 163] } },
] as const;

/** Every physical page of the real book that is an Exhibit R-2 (PE-level)
 * page -- none may ever be a member of an R-2A project group. */
const REAL_R2_PAGES = [43, 44, 45, 126, 127, 132, 133, 134, 161, 164, 165];

/* ------------------------------------------------------------------ */
/* Synthetic fixtures (generic identifiers, not the real document)     */
/* ------------------------------------------------------------------ */

function makeBlock(blockIndex: number, blockType: LayoutBlockV1['blockType'], text: string): LayoutBlockV1 {
  return { blockIndex, blockType, text };
}

function identityRow(peValue: string | null, projectValue: string | null): Array<{ rowIndex: number; columnIndex: number; text: string }> {
  const cells: Array<{ rowIndex: number; columnIndex: number; text: string }> = [];
  if (peValue != null) cells.push({ rowIndex: 0, columnIndex: 0, text: `R-1 Program Element (Number/Name)\n${peValue}` });
  if (projectValue != null) cells.push({ rowIndex: 0, columnIndex: 1, text: `Project (Number/Name)\n${projectValue}` });
  return cells;
}

const COST_HEADER = [
  'COST ($ in Millions)',
  'Prior\nYears',
  'FY 2022',
  'FY 2023',
  'FY 2024\nBase',
  'FY 2024\nOCO',
  'FY 2024\nTotal',
  'FY 2025',
  'FY 2026',
  'FY 2027',
  'FY 2028',
  'Cost To\nComplete',
  'Total\nCost',
];

function costTable(
  tableIndex: number,
  identity: Array<{ rowIndex: number; columnIndex: number; text: string }>,
  rows: string[][],
): ParsedTableV1 {
  const cells: Array<{ rowIndex: number; columnIndex: number; text: string }> = [...identity];
  const headerRow = identity.length > 0 ? 1 : 0;
  COST_HEADER.forEach((text, columnIndex) => cells.push({ rowIndex: headerRow, columnIndex, text }));
  rows.forEach((row, i) => row.forEach((text, columnIndex) => cells.push({ rowIndex: headerRow + 1 + i, columnIndex, text })));
  return { tableIndex, rowCount: headerRow + 1 + rows.length, columnCount: COST_HEADER.length, cells, warnings: [] };
}

/** An R-2A project page in the real government shape: R-2A marker, PE +
 * project identity cells, and the project's own cost row. */
function r2aProjectPage(input: {
  page: number;
  peCode: string;
  peTitle: string;
  projectCode: string;
  projectName: string;
  costRow: string[];
}): ParserPageResultV1 {
  return {
    page: input.page,
    text: `Exhibit R-2A, RDT&E Project Justification: PB 2024 Navy\nPE ${input.peCode}: ${input.peTitle}\nCOST ($ in Millions)`,
    blocks: [makeBlock(0, 'header', 'Exhibit R-2A, RDT&E Project Justification: PB 2024 Navy')],
    tables: [
      costTable(
        0,
        identityRow(`PE ${input.peCode} / ${input.peTitle}`, `${input.projectCode} / ${input.projectName}`),
        [input.costRow],
      ),
    ],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** An Exhibit R-2 PE-summary page: R-2 marker, PE identity cell, NO
 * project cell, "Total Program Element" row plus project rows. */
function r2PeSummaryPage(input: {
  page: number;
  peCode: string;
  peTitle: string;
  rows: string[][];
  /** Drop the exhibit marker text entirely (cells only) to prove the
   * structural PE cell alone is a boundary. */
  omitMarker?: boolean;
}): ParserPageResultV1 {
  const marker = input.omitMarker ? '' : 'Exhibit R-2, RDT&E Budget Item Justification: PB 2024 Navy';
  return {
    page: input.page,
    text: `${marker}\nPE ${input.peCode}: ${input.peTitle}\nCOST ($ in Millions)`,
    blocks: marker ? [makeBlock(0, 'header', marker)] : [],
    tables: [costTable(0, identityRow(`PE ${input.peCode} / ${input.peTitle}`, null), input.rows)],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A header-less narrative continuation page (no marker, no tables). */
function continuationPage(page: number): ParserPageResultV1 {
  return {
    page,
    blocks: [makeBlock(0, 'paragraph', `Continued narrative on page ${page} with no repeated header table.`)],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A different-exhibit page (R-4 schedule) with no R-2A marker. */
function otherExhibitPage(page: number, peCode: string): ParserPageResultV1 {
  return {
    page,
    text: `Exhibit R-4, RDT&E Schedule Profile: PB 2024 Navy\nPE ${peCode}`,
    blocks: [makeBlock(0, 'header', 'Exhibit R-4, RDT&E Schedule Profile: PB 2024 Navy')],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

const PE_A = { peCode: '0603001N', peTitle: 'Alpha Applied Research' };
const PE_B = { peCode: '0603002N', peTitle: 'Bravo Applied Research' };
const ROW_A1 = ['1234: Alpha Project One', '-', '10.000', '11.000', '12.000', '-', '12.000', '13.000', '14.000', '15.000', '16.000', '0.000', '91.000'];
const ROW_A2 = ['2345: Alpha Project Two (CA)', '-', '5.000', '6.000', '-', '-', '-', '-', '-', '-', '-', '0.000', '11.000'];
const ROW_B_TOTAL = ['Total Program Element', '-', '70.000', '71.000', '72.000', '-', '72.000', '73.000', '74.000', '75.000', '76.000', '0.000', '511.000'];
const ROW_B1 = ['3456: Bravo Project One', '-', '70.000', '71.000', '72.000', '-', '72.000', '73.000', '74.000', '75.000', '76.000', '0.000', '511.000'];
const ROW_B1_R2A = ['3456: Bravo Project One', '-', '70.000', '71.000', '72.000', '-', '72.000', '73.000', '74.000', '75.000', '76.000', '0.000', '511.000'];

function outyears(values: ReturnType<typeof extractR2aProjectFunding>['values']) {
  return values.filter((v) => v.columnRole === 'outyear_projection' && v.disposition === 'project_budget_position');
}

/* ------------------------------------------------------------------ */
/* Real transitions                                                    */
/* ------------------------------------------------------------------ */

describe('Phase 10B-35 -- R-2A identity never crosses a PE / exhibit boundary (real FY2024 Army R-2 Vol 1 BA1)', () => {
  const pages = readRealFixturePages();
  const grouping = groupR2aPagesByStructuralIdentityV1(pages);

  it('classifies every real Exhibit R-2 page as an explicit exhibit boundary, never as a header-less continuation', () => {
    for (const pageNumber of REAL_R2_PAGES) {
      const page = pages.find((p) => p.page === pageNumber);
      expect(page).toBeDefined();
      const result = extractR2aStructuralHeaderV1(page!);
      expect({ page: pageNumber, status: result.status }).toEqual({ page: pageNumber, status: 'exhibit_boundary' });
    }
  });

  it('no R-2A project group contains any Exhibit R-2 page', () => {
    const memberPages = new Set(grouping.groups.flatMap((g) => g.pages.map((p) => p.page)));
    for (const pageNumber of REAL_R2_PAGES) {
      expect({ page: pageNumber, inGroup: memberPages.has(pageNumber) }).toEqual({ page: pageNumber, inGroup: false });
    }
  });

  it.each(REAL_TRANSITIONS)(
    'transition into PE $newPe: the previous project $leakedFrom.projectCode keeps exactly its own pages and does not inherit $r2Pages',
    ({ r2Pages, leakedFrom }) => {
      const group = grouping.groups.find(
        (g) => g.parentPeCode === leakedFrom.parentPeCode && g.projectCode === leakedFrom.projectCode,
      );
      expect(group).toBeDefined();
      expect(group!.pages.map((p) => p.page)).toEqual([...leakedFrom.pages]);
      for (const p of r2Pages) expect(group!.pages.some((x) => x.page === p)).toBe(false);
    },
  );

  it('records each real boundary with the PE it opens (the R-2 stage owns those pages)', () => {
    const boundaryPages = new Map(boundariesOf(grouping).map((b) => [b.page, b]));
    for (const t of REAL_TRANSITIONS) {
      const first = boundaryPages.get(t.r2Pages[0]);
      expect(first).toBeDefined();
      expect(first!.kind).toBe('pe_summary');
      expect(first!.peCode).toBe(t.newPe);
    }
    // page 43 opens the book's first PE the same way
    expect(boundaryPages.get(43)?.peCode).toBe('0601102A');
  });

  it('still forms exactly the 22 real project groups, each page sharing its group PE, and never emits an omission for an R-2 page', () => {
    expect(grouping.groups).toHaveLength(22);
    expect(new Set(grouping.groups.map((g) => g.parentPeCode)).size).toBe(5);
    for (const pageNumber of REAL_R2_PAGES) {
      expect(grouping.omissions.some((o) => o.page === pageNumber)).toBe(false);
    }
    const identities = extractR2aProjectsFromPages({ pages }).identities;
    expect(identities).toHaveLength(22);
  });

  it('project funding: zero outyear values on any Exhibit R-2 page; the 76 legitimate outyear values keep their own-page identity', () => {
    const all = grouping.groups.flatMap((group) =>
      outyears(extractR2aProjectFunding({ group: { parentPeCode: group.parentPeCode, projectCode: group.projectCode, pages: group.pages }, cycleFiscalYear: 2024 }).values),
    );
    const onR2Pages = all.filter((v) => REAL_R2_PAGES.includes(v.page));
    expect(onR2Pages.map((v) => `${v.page}:${v.parentPeCode}/${v.projectCode}:FY${v.fiscalYear}=${v.valueMillions}`)).toEqual([]);
    expect(all).toHaveLength(76);
    // every remaining outyear value sits on a page whose own structural
    // header names exactly that PE / project
    for (const v of all) {
      const page = pages.find((p) => p.page === v.page)!;
      const header = extractR2aStructuralHeaderV1(page);
      expect(header.status).toBe('ok');
      if (header.status === 'ok') {
        expect(`${header.header.parentPeCode}/${header.header.projectCode}`).toBe(`${v.parentPeCode}/${v.projectCode}`);
      }
    }
    // the specific misbinding from the review packet: 78.009 is PE 0601103A's
    // FY2025 figure (page 126) and must not be asserted for 0601102A/T14
    expect(all.some((v) => v.parentPeCode === '0601102A' && v.projectCode === 'T14')).toBe(false);
    expect(all.filter((v) => v.valueMillions === '78.009')).toHaveLength(1);
    expect(all.find((v) => v.valueMillions === '78.009')).toMatchObject({ parentPeCode: '0601103A', projectCode: 'AB3', page: 128, fiscalYear: 2025 });
  });
});

/* ------------------------------------------------------------------ */
/* Generic controls                                                    */
/* ------------------------------------------------------------------ */

describe('Phase 10B-35 -- generic boundary controls (synthetic pages, different identifiers and positions)', () => {
  it('an R-2 PE-summary page following an R-2A section is a boundary: nothing is inherited, and the next PE\'s first project starts a fresh group', () => {
    const pages = [
      r2aProjectPage({ page: 200, ...PE_A, projectCode: '1234', projectName: 'Alpha Project One', costRow: ROW_A1 }),
      r2aProjectPage({ page: 201, ...PE_A, projectCode: '2345', projectName: 'Alpha Project Two (CA)', costRow: ROW_A2 }),
      r2PeSummaryPage({ page: 202, ...PE_B, rows: [ROW_B_TOTAL, ROW_B1] }),
      continuationPage(203),
      r2aProjectPage({ page: 204, ...PE_B, projectCode: '3456', projectName: 'Bravo Project One', costRow: ROW_B1_R2A }),
    ];
    const grouping = groupR2aPagesByStructuralIdentityV1(pages);
    expect(grouping.groups.map((g) => ({ id: `${g.parentPeCode}/${g.projectCode}`, pages: g.pages.map((p) => p.page) }))).toEqual([
      { id: '0603001N/1234', pages: [200] },
      { id: '0603001N/2345', pages: [201] },
      { id: '0603002N/3456', pages: [204] },
    ]);
    expect(boundariesOf(grouping)).toEqual([
      expect.objectContaining({ page: 202, kind: 'pe_summary', peCode: '0603002N' }),
    ]);
    expect(grouping.omissions).toEqual([]);

    const funding = grouping.groups.flatMap((group) => outyears(extractR2aProjectFunding({ group, cycleFiscalYear: 2024 }).values));
    // no project funding at all from page 202 (PE total 73.000.. and project 73.000..)
    expect(funding.filter((v) => v.page === 202)).toEqual([]);
    // 2345 has blank outyears ("-") -> blank is not zero and not inherited from the next page
    expect(funding.filter((v) => v.projectCode === '2345')).toEqual([]);
    // 3456's outyears come only from its own R-2A page
    expect(funding.filter((v) => v.projectCode === '3456').map((v) => [v.page, v.fiscalYear, v.valueMillions])).toEqual([
      [204, 2025, '73'],
      [204, 2026, '74'],
      [204, 2027, '75'],
      [204, 2028, '76'],
    ]);
  });

  it('the structural PE cell alone (no exhibit marker text at all) is still a boundary', () => {
    const pages = [
      r2aProjectPage({ page: 300, ...PE_A, projectCode: '1234', projectName: 'Alpha Project One', costRow: ROW_A1 }),
      r2PeSummaryPage({ page: 301, ...PE_B, rows: [ROW_B_TOTAL, ROW_B1], omitMarker: true }),
    ];
    const result = extractR2aStructuralHeaderV1(pages[1]!);
    expect(result.status).toBe('exhibit_boundary');
    const grouping = groupR2aPagesByStructuralIdentityV1(pages);
    expect(grouping.groups.map((g) => g.pages.map((p) => p.page))).toEqual([[300]]);
  });

  it('a different exhibit (R-4) with no R-2A marker is a boundary too, and a valid header-less continuation still inherits within its own section', () => {
    const pages = [
      r2aProjectPage({ page: 400, ...PE_A, projectCode: '1234', projectName: 'Alpha Project One', costRow: ROW_A1 }),
      continuationPage(401),
      otherExhibitPage(402, PE_A.peCode),
      continuationPage(403),
    ];
    const grouping = groupR2aPagesByStructuralIdentityV1(pages);
    expect(grouping.groups.map((g) => g.pages.map((p) => p.page))).toEqual([[400, 401]]);
    expect(boundariesOf(grouping).map((b) => [b.page, b.kind])).toEqual([[402, 'other_exhibit']]);
  });

  it('continuation inheritance requires physical adjacency: a header-less page after a gap never extends the section', () => {
    const pages = [
      r2aProjectPage({ page: 500, ...PE_A, projectCode: '1234', projectName: 'Alpha Project One', costRow: ROW_A1 }),
      continuationPage(502),
    ];
    const grouping = groupR2aPagesByStructuralIdentityV1(pages);
    expect(grouping.groups.map((g) => g.pages.map((p) => p.page))).toEqual([[500]]);
  });

  it('conflicting headers still fail closed and reset the section', () => {
    const conflicting: ParserPageResultV1 = {
      page: 601,
      text: 'Exhibit R-2A, RDT&E Project Justification',
      blocks: [makeBlock(0, 'header', 'Exhibit R-2A, RDT&E Project Justification')],
      tables: [
        {
          tableIndex: 0,
          rowCount: 2,
          columnCount: 2,
          cells: [
            ...identityRow(`PE ${PE_A.peCode} / ${PE_A.peTitle}`, '1234 / Alpha Project One'),
            { rowIndex: 1, columnIndex: 0, text: `R-1 Program Element (Number/Name)\nPE ${PE_B.peCode} / ${PE_B.peTitle}` },
            { rowIndex: 1, columnIndex: 1, text: 'Project (Number/Name)\n1234 / Alpha Project One' },
          ],
          warnings: [],
        },
      ],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    };
    const pages = [
      r2aProjectPage({ page: 600, ...PE_A, projectCode: '1234', projectName: 'Alpha Project One', costRow: ROW_A1 }),
      conflicting,
      continuationPage(602),
    ];
    const grouping = groupR2aPagesByStructuralIdentityV1(pages);
    expect(grouping.groups.map((g) => g.pages.map((p) => p.page))).toEqual([[600]]);
    expect(grouping.omissions.map((o) => [o.page, o.reason])).toEqual([[601, 'conflicting_headers_on_page']]);
  });

  it('defence in depth: a "Total Program Element" row inside a project group is never a project row -- it fails closed with an explicit reason', () => {
    // Externally supplied group that (wrongly) spans an R-2 page: the
    // funding extractor must still refuse to turn the PE total into project money.
    const leaked = r2PeSummaryPage({ page: 702, ...PE_B, rows: [ROW_B_TOTAL, ROW_B1] });
    const result = extractR2aProjectFunding({
      group: { parentPeCode: PE_A.peCode, projectCode: '2345', pages: [leaked] },
      cycleFiscalYear: 2024,
    });
    expect(result.values.filter((v) => v.rowIndex === 2)).toEqual([]);
    const peTotalOmissions = result.omissions.filter((o) => o.reason === 'pe_total_row_in_project_table');
    expect(peTotalOmissions.length).toBeGreaterThanOrEqual(8);
    expect(peTotalOmissions.every((o) => o.page === 702 && o.rowIndex === 2)).toBe(true);
    expect(peTotalOmissions.map((o) => o.rawText)).toEqual(expect.arrayContaining(['73.000', '74.000', '75.000', '76.000']));
  });
});
