/**
 * r2a-project-extractor-v1.spec — Workstream H tests, rewritten for
 * Phase 10B-25 (Defect 1: R-2A structural project identity).
 *
 * Phase 10B-25 root cause: the real government R-2A layout prints project
 * identity as self-labeled structural TABLE CELLS ("R-1 Program Element
 * (Number/Name)" / "Project (Number/Name)") -- never as an inline
 * "Project Code:" body-text label. All fixtures below build that real
 * cell shape via `makeR2aPage` (see r2a-structural-project-header-parser-
 * v1.ts for the full root-cause writeup). A handful of tests that
 * exercise `extractR2aProjectsFromGroups`'s own group-level validation
 * directly (bypassing the shared structural grouper -- e.g. an externally
 * pre-segmented group with an invalid code) intentionally keep
 * table-free synthetic pages, since that entry point never re-derives
 * identity from page content at all.
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
import {
  extractR2aProjectsFromGroups,
  extractR2aProjectsFromPages,
} from './r2a-project-extractor-v1.js';
import {
  extractR2aStructuralHeaderV1,
  groupR2aPagesByStructuralIdentityV1,
} from './r2a-structural-project-header-parser-v1.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                      */
/* ------------------------------------------------------------------ */

function makeBlock(
  blockIndex: number,
  blockType: LayoutBlockV1['blockType'],
  text: string,
): LayoutBlockV1 {
  return { blockIndex, blockType, text };
}

function identityTable(peValue: string | null, projectValue: string | null): ParsedTableV1 {
  const cells: Array<{ rowIndex: number; columnIndex: number; text: string }> = [];
  if (peValue != null) {
    cells.push({
      rowIndex: 0,
      columnIndex: 0,
      text: `R-1 Program Element (Number/Name)\n${peValue}`,
    });
  }
  if (projectValue != null) {
    cells.push({
      rowIndex: 0,
      columnIndex: 1,
      text: `Project (Number/Name)\n${projectValue}`,
    });
  }
  return {
    tableIndex: 0,
    rowCount: 1,
    columnCount: 2,
    cells,
    warnings: [],
  };
}

/** A real-shape R-2A project header page: the R-2A marker plus a single
 * table row carrying the PE and project identity cells exactly as the
 * real FY2024 Army R-2A exhibit prints them. */
function makeR2aPage(input: {
  page: number;
  peCode: string;
  peTitle: string;
  projectCode: string;
  projectName: string;
  extraBlocks?: LayoutBlockV1[];
  printedTitle?: string;
}): ParserPageResultV1 {
  return {
    page: input.page,
    text: 'R-2A',
    blocks: [
      makeBlock(0, 'header', 'R-2A'),
      ...(input.printedTitle != null
        ? [makeBlock(90, 'text', `Project Title: ${input.printedTitle}`)]
        : []),
      ...(input.extraBlocks ?? []),
    ],
    tables: [identityTable(`PE ${input.peCode} / ${input.peTitle}`, `${input.projectCode} / ${input.projectName}`)],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A page carrying the R-2A marker with a PE cell but NO project cell
 * (missing_parent_pe/missing_project_code test scaffolding). */
function makeR2aPagePartial(input: {
  page: number;
  peValue: string | null;
  projectValue: string | null;
  extraBlocks?: LayoutBlockV1[];
}): ParserPageResultV1 {
  return {
    page: input.page,
    text: 'R-2A',
    blocks: [makeBlock(0, 'header', 'R-2A'), ...(input.extraBlocks ?? [])],
    tables: [identityTable(input.peValue, input.projectValue)],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A page with the R-2A marker and conflicting PE (or project) cells. */
function makeR2aPageConflicting(page: number): ParserPageResultV1 {
  return {
    page,
    text: 'R-2A',
    blocks: [makeBlock(0, 'header', 'R-2A')],
    tables: [
      {
        tableIndex: 0,
        rowCount: 2,
        columnCount: 2,
        cells: [
          { rowIndex: 0, columnIndex: 0, text: 'R-1 Program Element (Number/Name)\nPE 0601101A / First' },
          { rowIndex: 0, columnIndex: 1, text: 'Project (Number/Name)\nAB1 / Alpha' },
          { rowIndex: 1, columnIndex: 0, text: 'R-1 Program Element (Number/Name)\nPE 0602102A / Second' },
          { rowIndex: 1, columnIndex: 1, text: 'Project (Number/Name)\nAB1 / Alpha' },
        ],
        warnings: [],
      },
    ],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A page that merely mentions R-2A / projects in prose, with no
 * structural identity table at all -- must never become a project page. */
function makeNarrativeOnlyPage(page: number, text: string): ParserPageResultV1 {
  return {
    page,
    blocks: [makeBlock(0, 'text', text)],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A legitimate continuation page: no R-2A marker at all, no identity
 * table -- only narrative continuation text. Inherits identity from the
 * currently open section (never starts one on its own). */
function makeContinuationPage(page: number, text: string): ParserPageResultV1 {
  return {
    page,
    blocks: [makeBlock(0, 'paragraph', text)],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

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
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
  const parsed = parseParserRuntimeResultV1(raw);
  if (parsed.inputSourceSha256 !== REAL_FIXTURE_SHA) {
    throw new Error(
      `real fixture source SHA drifted: expected ${REAL_FIXTURE_SHA}, got ${parsed.inputSourceSha256}`,
    );
  }
  return parsed.pages as ParserPageResultV1[];
}

/* ------------------------------------------------------------------ */
/* Narrative section extraction (unaffected by the identity rewrite,   */
/* but still exercised through the real structural entry point)        */
/* ------------------------------------------------------------------ */

describe('r2a-project-section-extractor', () => {
  it('extracts mission, accomplishments, and plans sections', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research Project',
      extraBlocks: [
        makeBlock(1, 'heading', 'Mission'),
        makeBlock(2, 'paragraph', 'Conduct basic research.'),
        makeBlock(3, 'heading', 'Accomplishments'),
        makeBlock(4, 'paragraph', 'Published three papers.'),
        makeBlock(5, 'heading', 'Plans'),
        makeBlock(6, 'paragraph', 'Continue research.'),
      ],
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.narratives.length).toBeGreaterThanOrEqual(3);
    const kinds = result.narratives.map((n) => n.kind);
    expect(kinds).toContain('mission');
    expect(kinds).toContain('accomplishments');
    expect(kinds).toContain('plans');
  });

  it('handles description section', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'XY',
      projectName: 'Test',
      extraBlocks: [
        makeBlock(1, 'heading', 'Description'),
        makeBlock(2, 'paragraph', 'Detailed description text.'),
      ],
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.narratives.some((n) => n.kind === 'description')).toBe(true);
  });

  it('skips non-narrative blocks like footers and page numbers', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research',
      extraBlocks: [
        makeBlock(1, 'heading', 'Mission'),
        makeBlock(2, 'paragraph', 'Real mission text.'),
        makeBlock(3, 'footer', 'Page 42'),
        makeBlock(4, 'text', 'R-2A'),
      ],
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    const mission = result.narratives.find((n) => n.kind === 'mission');
    expect(mission?.text).toBe('Real mission text.');
  });

  it('preserves narrative text exactly without summarization', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research',
      extraBlocks: [
        makeBlock(1, 'heading', 'Mission'),
        makeBlock(
          2,
          'paragraph',
          'This is a very specific mission statement that must not be altered.',
        ),
      ],
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    const mission = result.narratives.find((n) => n.kind === 'mission');
    expect(mission?.text).toBe(
      'This is a very specific mission statement that must not be altered.',
    );
  });
});

/* ------------------------------------------------------------------ */
/* Defect 1 required regression scenarios (Phase 10B-25)               */
/* ------------------------------------------------------------------ */

describe('Phase 10B-25 Defect 1 — R-2A structural project identity', () => {
  it('1. resolves the real "Project (Number/Name)" table-cell header layout (happy path)', () => {
    const page = makeR2aPage({
      page: 46,
      peCode: '0601102A',
      peTitle: 'Defense Research Sciences',
      projectCode: 'AA1',
      projectName: 'ILIR - AMC',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    const id = result.identities[0]!;
    expect(id.parentPeCode).toBe('0601102A');
    expect(id.projectCode).toBe('AA1');
    expect(id.title).toBe('ILIR - AMC');
    expect(id.pages).toEqual([46]);
    expect(result.omissions).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
  });

  it('2. groups multiple distinct projects under one parent PE', () => {
    const page1 = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'First Project',
    });
    const page2 = makeR2aPage({
      page: 2,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'CD2',
      projectName: 'Second Project',
    });
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities).toHaveLength(2);
    const codes = result.identities.map((i) => i.projectCode).sort();
    expect(codes).toEqual(['AB1', 'CD2']);
    expect(result.identities.every((i) => i.parentPeCode === '0601101A')).toBe(true);
  });

  it('3. resets identity correctly at a transition between two parent PEs', () => {
    const page1 = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Under PE One',
    });
    const page2 = makeR2aPage({
      page: 2,
      peCode: '0602102A',
      peTitle: 'Applied Research',
      projectCode: 'AB1',
      projectName: 'Under PE Two',
    });
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    // Same project code "AB1" under two DIFFERENT parent PEs must never
    // merge into one group -- identity is scoped to (parentPeCode, projectCode).
    expect(result.identities).toHaveLength(2);
    const pes = result.identities.map((i) => i.parentPeCode).sort();
    expect(pes).toEqual(['0601101A', '0602102A']);
    expect(result.identities.every((i) => i.pages.length === 1)).toBe(true);
  });

  it('4. a continuation page with no repeated header inherits identity from the immediately preceding valid page', () => {
    const header = makeR2aPage({
      page: 10,
      peCode: '0601102A',
      peTitle: 'Defense Research Sciences',
      projectCode: 'AA1',
      projectName: 'ILIR - AMC',
      extraBlocks: [makeBlock(1, 'heading', 'Mission'), makeBlock(2, 'paragraph', 'First page mission.')],
    });
    const continuation = makeContinuationPage(11, 'Continued narrative with no repeated header table.');
    const result = extractR2aProjectsFromPages({ pages: [header, continuation] });
    expect(result.identities).toHaveLength(1);
    const id = result.identities[0]!;
    expect(id.parentPeCode).toBe('0601102A');
    expect(id.projectCode).toBe('AA1');
    expect(id.pages).toEqual([10, 11]);
    expect(result.omissions).toHaveLength(0);
  });

  it('5. missing parent PE fails closed with an explicit omission (never blocked silently, never a group)', () => {
    const page = makeR2aPagePartial({ page: 5, peValue: null, projectValue: 'AB1 / No Parent PE' });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.reason).toBe('missing_parent_pe_on_page');
    expect(result.omissions[0]?.page).toBe(5);
  });

  it('6. missing project code fails closed with an explicit omission -- group is NEVER formed with an empty code', () => {
    const page = makeR2aPagePartial({
      page: 7,
      peValue: 'PE 0601101A / Advanced Technology',
      projectValue: null,
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.reason).toBe('missing_project_code_on_page');
    expect(result.omissions[0]?.parentPeCode).toBe('0601101A');
    // Explicit: no identity was ever formed with an empty project code.
    expect(result.identities.some((i) => i.projectCode === '')).toBe(false);
  });

  it('7. conflicting PE/project headers on one page fail closed with an explicit omission', () => {
    const page = makeR2aPageConflicting(20);
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.reason).toBe('conflicting_headers_on_page');
    expect(result.omissions[0]?.page).toBe(20);
  });

  it('8. narrative text merely mentioning R-2A/projects, with no real structural header, never becomes a group', () => {
    const page = makeNarrativeOnlyPage(
      6,
      'Explanations for these changes can be found in the narrative sections ' +
        'of the Program Element R-2A Exhibits.',
    );
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
    expect(result.blocked).toHaveLength(0);
    expect(result.omissions).toHaveLength(0);
  });

  it('9. no group is ever produced with an empty project code, across a mixed batch of valid/invalid/narrative-only pages', () => {
    const pages = [
      makeR2aPage({
        page: 1,
        peCode: '0601101A',
        peTitle: 'Advanced Technology',
        projectCode: 'AB1',
        projectName: 'Valid',
      }),
      makeR2aPagePartial({ page: 2, peValue: null, projectValue: 'CD2 / No PE' }),
      makeR2aPagePartial({ page: 3, peValue: 'PE 0601101A / Advanced Technology', projectValue: null }),
      makeR2aPageConflicting(4),
      makeNarrativeOnlyPage(5, 'This page just explains what R-2A Exhibits are.'),
    ];
    const { groups, omissions } = groupR2aPagesByStructuralIdentityV1(pages);
    expect(groups.every((g) => g.projectCode.trim().length > 0)).toBe(true);
    expect(groups.every((g) => g.parentPeCode.trim().length > 0)).toBe(true);
    expect(groups).toHaveLength(1);
    expect(omissions).toHaveLength(3);
    const result = extractR2aProjectsFromPages({ pages });
    expect(result.identities.some((i) => i.projectCode === '')).toBe(false);
    expect(result.identities.some((i) => i.parentPeCode === '')).toBe(false);
  });

  it('10. real fixture pages 126, 161, 164 are correctly out-of-scope for the R-2A extractor (genuine Exhibit R-2 pages)', () => {
    const pages = readRealFixturePages();
    for (const pageNumber of [126, 161, 164]) {
      const page = pages.find((p) => p.page === pageNumber);
      expect(page).toBeDefined();
      const result = extractR2aStructuralHeaderV1(page!);
      // Never resolved as a valid R-2A identity page, and never surfaced
      // as an omission either -- these pages structurally never carry a
      // project cell or the R-2A marker, so the R-2A extractor's own
      // grouping never touches them at all (their pre-existing
      // ambiguous_layout findings originate from the unrelated R-2
      // PE-level extractor stage, untouched by this change).
      expect(result.status).toBe('not_r2a_page');
    }
    const { omissions } = groupR2aPagesByStructuralIdentityV1(pages);
    for (const pageNumber of [126, 161, 164]) {
      expect(omissions.some((o) => o.page === pageNumber)).toBe(false);
    }
  });

  it('11. the complete real 170-page fixture end-to-end resolves the actual derived project-group count', () => {
    const pages = readRealFixturePages();
    const { groups, omissions } = groupR2aPagesByStructuralIdentityV1(pages);
    // Evidence-derived, not hardcoded ahead of a real run: 117 pages carry
    // (PE cell + project cell + R-2A marker) partitioning into exactly 22
    // valid project groups across exactly 5 distinct PE codes, spanning
    // pages 46-170 (see Phase 10B-25 resume-state fixture analysis).
    expect(groups).toHaveLength(22);
    const distinctPeCodes = new Set(groups.map((g) => g.parentPeCode));
    expect(distinctPeCodes.size).toBe(5);
    expect(groups.every((g) => g.projectCode.trim().length > 0)).toBe(true);
    expect(groups.every((g) => g.parentPeCode.trim().length > 0)).toBe(true);
    const minPage = Math.min(...groups.flatMap((g) => g.pages.map((p) => p.page)));
    const maxPage = Math.max(...groups.flatMap((g) => g.pages.map((p) => p.page)));
    expect(minPage).toBeGreaterThanOrEqual(46);
    expect(maxPage).toBeLessThanOrEqual(170);
    // The 11 genuine Exhibit R-2 PE-summary pages (43-45,126-127,132-134,
    // 161,164-165) never enter an R-2A omission -- confirmed out of scope.
    for (const pageNumber of [43, 44, 45, 126, 127, 132, 133, 134, 161, 164, 165]) {
      expect(omissions.some((o) => o.page === pageNumber)).toBe(false);
    }

    const result = extractR2aProjectsFromPages({ pages });
    expect(result.identities).toHaveLength(22);
    expect(result.identities.some((i) => i.projectCode === '')).toBe(false);
    expect(result.identities.some((i) => i.parentPeCode === '')).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Legacy behaviors preserved with real-shape structural fixtures      */
/* ------------------------------------------------------------------ */

describe('r2a-project-extractor-v1', () => {
  it('handles 2-character project codes', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'A1',
      projectName: 'Short Code',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('A1');
  });

  it('handles 8-character project codes with punctuation', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB-12.34',
      projectName: 'Long Code',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('AB-12.34');
  });

  it('does not truncate long project codes', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'ABCDEFGHIJ',
      projectName: 'Very Long Code',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('ABCDEFGHIJ');
  });

  it('handles repeated project headers across pages (same project, multiple pages)', () => {
    const page1 = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research',
      extraBlocks: [makeBlock(1, 'heading', 'Mission'), makeBlock(2, 'paragraph', 'First part.')],
    });
    const page2 = makeR2aPage({
      page: 2,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research',
      extraBlocks: [
        makeBlock(1, 'heading', 'Accomplishments'),
        makeBlock(2, 'paragraph', 'Second part.'),
      ],
    });
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.pages).toEqual([1, 2]);
    expect(result.narratives.some((n) => n.kind === 'mission')).toBe(true);
    expect(result.narratives.some((n) => n.kind === 'accomplishments')).toBe(true);
  });

  it('detects conflicting titles across pages (same project, different printed names)', () => {
    const page1 = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research Alpha',
    });
    const page2 = makeR2aPage({
      page: 2,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research Beta',
    });
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities[0]?.title).toBe('Research Alpha');
    expect(result.identities[0]?.aliases).toContain('Research Beta');
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.field).toBe('title');
    expect(result.conflicts[0]?.values).toContain('Research Alpha');
    expect(result.conflicts[0]?.values).toContain('Research Beta');
  });

  it('skips R-2A pages mislabeled as R-2 header text (no R-2A marker at all)', () => {
    const page: ParserPageResultV1 = {
      page: 1,
      text: 'R-2',
      blocks: [makeBlock(0, 'header', 'R-2')],
      tables: [identityTable('PE 0601101A / Advanced Technology', 'AB1 / Mislabeled')],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    };
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(0);
  });

  it('inherits budget activity from PE context when not printed on the page', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Research',
    });
    const result = extractR2aProjectsFromPages({
      pages: [page],
      peContext: { budgetActivity: 'BA 2', budgetActivityName: 'Applied Research' },
    });
    expect(result.identities[0]?.budgetActivity).toBe('BA 2');
    expect(result.identities[0]?.budgetActivityName).toBe('Applied Research');
  });

  it('handles project with no narrative sections', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Bare Project',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.narratives).toHaveLength(0);
  });

  it('handles project code with punctuation allowed by policy', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'A.1-B',
      projectName: 'Punctuation',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities[0]?.projectCode).toBe('A.1-B');
  });

  it('falls back to the structural project name as the title when no printed "Project Title:" line exists', () => {
    const page = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'Structural Name As Title',
    });
    const result = extractR2aProjectsFromPages({ pages: [page] });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.title).toBe('Structural Name As Title');
    expect(result.omissions.some((o) => o.reason === 'missing_project_title')).toBe(false);
  });

  /* ---- Entry points that bypass the shared structural grouper -------- */
  /* extractR2aProjectsFromGroups is also called directly with externally
   * pre-segmented groups (e.g. Workstream E). That entry point never
   * re-derives identity from page content -- it only validates the
   * group's OWN (parentPeCode, projectCode) key. These tests exercise
   * that group-level validation path specifically and intentionally do
   * NOT go through extractR2aProjectsFromPages / the structural grouper. */

  it('blocks an externally pre-segmented group with no valid parent PE', () => {
    const page = makeNarrativeOnlyPage(1, 'irrelevant body text');
    const result = extractR2aProjectsFromGroups({
      groups: [{ parentPeCode: '', projectCode: 'AB1', pages: [page] }],
    });
    expect(result.identities).toHaveLength(0);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]?.reason).toBe('missing_or_invalid_parent_pe');
  });

  it('flags an externally pre-segmented group with a bounded-policy-invalid project code', () => {
    const page = makeNarrativeOnlyPage(1, 'irrelevant body text');
    const result = extractR2aProjectsFromGroups({
      groups: [{ parentPeCode: '0601101A', projectCode: 'AB 1', pages: [page] }],
    });
    expect(result.identities).toHaveLength(0);
    expect(result.omissions.some((o) => o.reason === 'invalid_project_code')).toBe(true);
  });

  it('extracts from externally pre-segmented groups using printed title text', () => {
    const page: ParserPageResultV1 = {
      page: 1,
      text: 'R-2A',
      blocks: [
        makeBlock(0, 'header', 'R-2A'),
        makeBlock(1, 'text', 'Project Title: Grouped'),
      ],
      tables: [],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    };
    const result = extractR2aProjectsFromGroups({
      groups: [{ parentPeCode: '0601101A', projectCode: 'AB1', pages: [page] }],
    });
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.title).toBe('Grouped');
  });

  it('detects conflicts across externally pre-segmented duplicate groups', () => {
    const makePrintedTitlePage = (page: number, title: string): ParserPageResultV1 => ({
      page,
      text: 'R-2A',
      blocks: [makeBlock(0, 'header', 'R-2A'), makeBlock(1, 'text', `Project Title: ${title}`)],
      tables: [],
      images: [],
      evidencePrecision: 'page_only',
      warnings: [],
    });
    const result = extractR2aProjectsFromGroups({
      groups: [
        { parentPeCode: '0601101A', projectCode: 'AB1', pages: [makePrintedTitlePage(1, 'Alpha')] },
        { parentPeCode: '0601101A', projectCode: 'AB1', pages: [makePrintedTitlePage(2, 'Beta')] },
      ],
    });
    expect(result.conflicts.length).toBeGreaterThan(0);
  });

  it('handles multiple projects on the same parent PE via extractR2aProjectsFromPages', () => {
    const page1 = makeR2aPage({
      page: 1,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'AB1',
      projectName: 'First',
    });
    const page2 = makeR2aPage({
      page: 2,
      peCode: '0601101A',
      peTitle: 'Advanced Technology',
      projectCode: 'CD2',
      projectName: 'Second',
    });
    const result = extractR2aProjectsFromPages({ pages: [page1, page2] });
    expect(result.identities).toHaveLength(2);
    const codes = result.identities.map((i) => i.projectCode).sort();
    expect(codes).toEqual(['AB1', 'CD2']);
  });
});
