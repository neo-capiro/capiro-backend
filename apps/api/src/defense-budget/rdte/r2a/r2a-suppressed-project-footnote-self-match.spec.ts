/**
 * Regression: the real Army "*This project's R-2a exhibit has been
 * suppressed due to funding not beginning until after FY 2024" footnote
 * self-matches `R2A_MARKER_RE` and misroutes an Exhibit R-2 (PE-level) page
 * into the R-2A per-project branch, producing a false
 * `missing_project_code_on_page` omission.
 *
 * Root cause (found investigating production candidate
 * 9def0a42-79cb-5df5-8764-7b0f1d3de009, FY2024 Army RDT&E Vol 1 BA2, PE
 * 0602181A "All Domain Convergence Applied Research", physical page 429):
 *
 *   `R2A_MARKER_RE = /\bR-2A\b|RDT&E\s+Project\s+Justification/i` is
 *   evaluated against the WHOLE page text/blocks (`hasR2aMarker`), not just
 *   exhibit-header blocks. Real Army R-2 PE-summary pages print a standard
 *   footnote whenever one of the PE's projects has no FY2024 funding:
 *
 *     "*This project's R-2a exhibit has been suppressed due to funding not
 *     beginning until after FY 2024"
 *
 *   `/\bR-2A\b/i` matches the "R-2a" inside that ordinary prose footnote
 *   (case-insensitively), so `hasR2aMarker` returns true for a page that is
 *   genuinely an Exhibit R-2 PE-summary page (has an "R-1 Program Element
 *   (Number/Name)" cell, no "Project (Number/Name)" cell). That routes the
 *   page into `extractR2aStructuralHeaderV1`'s main branch instead of
 *   `classifyNonR2aPage`'s documented `pe_summary` exhibit-boundary carve-out
 *   (lines 366-378), and because no project cell exists, it falls into the
 *   `missing_project_code` branch and asserts a spurious omission against the
 *   PE's own summary page.
 *
 *   Confirmed on the real PDF: PE 0602181A's page 429 (printed "Volume 1b -
 *   387") carries this exact footnote below its COST table (project CM1 has
 *   no FY2024 funding), and the real extraction artifact
 *   (ef13b0e3c03f62e053ca25f617cca7b589070bf9481d9d1f08fc6c23394d3e88)
 *   contains exactly one `missing_project_code_on_page` omission for that
 *   page, with no row in its sourcePath (it is a page-level, not row-level,
 *   fact) -- which the scoped-fact-review policy's same-page independence
 *   gate then conservatively refuses to approve past (row_unknown never
 *   counts as `different_row`). The identical footnote also appears on PE
 *   0602146A's page 262 (a later continuation page, not its own summary
 *   page), producing the same spurious omission there too -- harmless only
 *   because it happens to land on a different page than that PE's approved
 *   total.
 *
 * This spec is deliberately a NEW, narrow file (not an edit to the existing
 * Phase 10B-35 `r2a-pe-exhibit-boundary-regression.spec.ts`) so the fix's
 * blast radius is easy to review in isolation. It reuses that file's fixture
 * shapes but is self-contained.
 */
import { describe, expect, it } from '@jest/globals';
import type {
  LayoutBlockV1,
  ParsedTableV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import {
  extractR2aStructuralHeaderV1,
  groupR2aPagesByStructuralIdentityV1,
} from './r2a-structural-project-header-parser-v1.js';
import { COST_HEADER, makeBlock } from './r2a-test-fixtures.js';

function costTable(
  peCell: string,
  projectCell: string | null,
  rows: string[][],
): ParsedTableV1 {
  const cells: Array<{ rowIndex: number; columnIndex: number; text: string }> = [
    { rowIndex: 0, columnIndex: 0, text: `R-1 Program Element (Number/Name)\n${peCell}` },
  ];
  if (projectCell != null) {
    cells.push({ rowIndex: 0, columnIndex: 1, text: `Project (Number/Name)\n${projectCell}` });
  }
  const headerRow = 1;
  COST_HEADER.forEach((text, columnIndex) => cells.push({ rowIndex: headerRow, columnIndex, text }));
  rows.forEach((row, i) => row.forEach((text, columnIndex) => cells.push({ rowIndex: headerRow + 1 + i, columnIndex, text })));
  return {
    tableIndex: 0,
    rowCount: headerRow + 1 + rows.length,
    columnCount: COST_HEADER.length,
    cells,
    warnings: [],
  };
}

const PE = { peCode: '0602181A', peTitle: 'All Domain Convergence Applied Research' };
const ROW_TOTAL = ['Total Program Element', '-', '25.019', '27.360', '14.297', '-', '14.297', '22.613', '20.651', '17.232', '9.988', '0.000', '137.160'];
const ROW_CM1_SUPPRESSED = ['CM1: Collab Battlefield Networked Leth Sys App Tech', '-', '-', '-', '-', '-', '-', '8.569', '10.516', '7.358', '-', '0.000', '26.443'];
const ROW_CM7 = ['CM7: Collaborative Convergence Applied Research', '-', '25.019', '27.360', '14.297', '-', '14.297', '14.044', '10.135', '9.874', '9.988', '0.000', '110.717'];

/** The real page shape: Exhibit R-2 marker, PE identity cell, NO project
 * cell, "Total Program Element" + project rows, and (when
 * `withSuppressionFootnote`) the real Army suppressed-project footnote as a
 * trailing narrative block -- exactly as printed on the real page 429. */
function r2PeSummaryPageWithFootnote(withSuppressionFootnote: boolean): ParserPageResultV1 {
  const marker = 'Exhibit R-2, RDT&E Budget Item Justification: PB 2024 Army';
  const footnote =
    "*This project's R-2a exhibit has been suppressed due to funding not beginning until after FY 2024";
  const blocks: LayoutBlockV1[] = [makeBlock(0, 'header', marker)];
  if (withSuppressionFootnote) blocks.push(makeBlock(1, 'paragraph', footnote));
  return {
    page: 429,
    text: [marker, `PE ${PE.peCode}: ${PE.peTitle}`, 'COST ($ in Millions)', ...(withSuppressionFootnote ? [footnote] : [])].join('\n'),
    blocks,
    tables: [costTable(`PE ${PE.peCode} / ${PE.peTitle}`, null, [ROW_TOTAL, ROW_CM1_SUPPRESSED, ROW_CM7])],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** A genuine R-2A project page (the shape that must keep matching after the
 * fix) -- real print: "Exhibit R-2A, RDT&E Project Justification: PB 2024
 * Army", with both a PE cell and a Project cell. `withSuppressionFootnote`
 * appends the same real footnote text used above (it can legitimately
 * appear on a genuine R-2A project page too, e.g. printed for a SIBLING
 * project's own suppressed exhibit note) so the "footnote or not" claim in
 * the test name is actually exercised in both directions, not just assumed. */
function genuineR2aProjectPage(page: number, withSuppressionFootnote = false): ParserPageResultV1 {
  const marker = 'Exhibit R-2A, RDT&E Project Justification: PB 2024 Army';
  const footnote =
    "*This project's R-2a exhibit has been suppressed due to funding not beginning until after FY 2024";
  const blocks: LayoutBlockV1[] = [makeBlock(0, 'header', marker)];
  if (withSuppressionFootnote) blocks.push(makeBlock(1, 'paragraph', footnote));
  return {
    page,
    text: [marker, `PE ${PE.peCode}: ${PE.peTitle}`, 'COST ($ in Millions)', ...(withSuppressionFootnote ? [footnote] : [])].join('\n'),
    blocks,
    tables: [
      costTable(`PE ${PE.peCode} / ${PE.peTitle}`, 'CM7 / Collaborative Convergence Applied Research', [ROW_CM7]),
    ],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

/** Negative control: a real R-2A page whose project cell is genuinely
 * missing (a true parsing/document defect, not the footnote false-positive)
 * -- the `missing_project_code` omission must still fire for this one. */
function genuineR2aPageMissingProjectCell(page: number): ParserPageResultV1 {
  const marker = 'Exhibit R-2A, RDT&E Project Justification: PB 2024 Army';
  return {
    page,
    text: `${marker}\nPE ${PE.peCode}: ${PE.peTitle}\nCOST ($ in Millions)`,
    blocks: [makeBlock(0, 'header', marker)],
    tables: [costTable(`PE ${PE.peCode} / ${PE.peTitle}`, null, [ROW_CM7])],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

describe('R2A_MARKER_RE self-match on the real suppressed-project footnote (PE 0602181A page 429)', () => {
  it('BASELINE (no footnote): a PE-summary page with no project cell is correctly an exhibit_boundary/pe_summary, never an omission', () => {
    const result = extractR2aStructuralHeaderV1(r2PeSummaryPageWithFootnote(false));
    expect(result.status).toBe('exhibit_boundary');
    if (result.status === 'exhibit_boundary') {
      expect(result.kind).toBe('pe_summary');
      expect(result.peCode).toBe(PE.peCode);
    }
  });

  it('DEFECT: the same page, with the real suppression footnote appended, must ALSO be exhibit_boundary/pe_summary -- not missing_project_code', () => {
    const result = extractR2aStructuralHeaderV1(r2PeSummaryPageWithFootnote(true));
    // Pre-fix this resolves to { status: 'missing_project_code', parentPeCode: '0602181A', ... }
    // because the footnote's "R-2a" self-matches R2A_MARKER_RE. That is the
    // exact defect behind the blocked scoped-review of PE 0602181A.
    expect(result.status).toBe('exhibit_boundary');
    if (result.status === 'exhibit_boundary') {
      expect(result.kind).toBe('pe_summary');
      expect(result.peCode).toBe(PE.peCode);
    }
  });

  it('DEFECT (grouping level): a footnoted PE-summary page never produces a missing_project_code_on_page omission and is never grouped as an R-2A section', () => {
    const grouping = groupR2aPagesByStructuralIdentityV1([r2PeSummaryPageWithFootnote(true)]);
    expect(grouping.omissions).toEqual([]);
    expect(grouping.groups).toEqual([]);
    expect(grouping.boundaries).toEqual([
      expect.objectContaining({ page: 429, kind: 'pe_summary', peCode: PE.peCode }),
    ]);
  });

  it('NEGATIVE CONTROL A: a genuine R-2A project page (with its own project cell) must still resolve ok, footnote or not', () => {
    for (const withSuppressionFootnote of [false, true]) {
      const result = extractR2aStructuralHeaderV1(genuineR2aProjectPage(430, withSuppressionFootnote));
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.header.parentPeCode).toBe(PE.peCode);
        expect(result.header.projectCode).toBe('CM7');
      }
    }
  });

  it('NEGATIVE CONTROL B: a genuine R-2A page missing its project cell for a real (non-footnote) reason must still raise missing_project_code -- the fix must not blanket-suppress this omission', () => {
    const result = extractR2aStructuralHeaderV1(genuineR2aPageMissingProjectCell(431));
    expect(result.status).toBe('missing_project_code');
    if (result.status === 'missing_project_code') {
      expect(result.parentPeCode).toBe(PE.peCode);
    }
  });
});
