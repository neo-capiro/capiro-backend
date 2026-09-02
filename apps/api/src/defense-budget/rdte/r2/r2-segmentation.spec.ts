/**
 * r2-segmentation.spec — Workstream E tests.
 *
 * Covers:
 *   - one PE over multiple pages;
 *   - back-to-back PEs;
 *   - R-2 to R-2A transition;
 *   - R-2A to R-3 transition;
 *   - missing continuation header;
 *   - conflicting headers;
 *   - printed page labels;
 *   - repeated footer noise;
 *   - parser output order permutation.
 */
import type {
  LayoutBlockV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { segmentR2ExhibitPages } from './r2-exhibit-segmenter.js';
import { resolveR2Contexts } from './r2-context-resolver.js';
import { extractR2Identities } from './r2-identity-extractor-v1.js';

/* ------------------------------------------------------------------ */
/* Fixture helpers                                                     */
/* ------------------------------------------------------------------ */

function makeBlock(
  blockIndex: number,
  blockType: LayoutBlockV1['blockType'],
  text: string,
): LayoutBlockV1 {
  return { blockIndex, blockType, text };
}

function makePage(input: {
  page: number;
  printedPage?: string;
  blocks?: LayoutBlockV1[];
  text?: string;
}): ParserPageResultV1 {
  return {
    page: input.page,
    ...(input.printedPage != null ? { printedPage: input.printedPage } : {}),
    text: input.text,
    blocks: input.blocks ?? [],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function r2PeHeader(peCode: string, title: string): LayoutBlockV1[] {
  return [
    makeBlock(0, 'header', 'RDT&E Budget Item Justification'),
    makeBlock(1, 'heading', `PE ${peCode} / ${title}`),
    makeBlock(2, 'text', 'A. Mission Description and Budget Item Justification'),
  ];
}

function r2ContinuationHeader(peCode: string): LayoutBlockV1[] {
  return [
    makeBlock(0, 'header', `RDT&E Budget Item Justification (continued)`),
    makeBlock(1, 'header', `PE ${peCode}`),
    makeBlock(2, 'text', 'B. Accomplishments/Planned Programs'),
  ];
}

function r2aProjectHeader(peCode: string, projectCode: string, title: string): LayoutBlockV1[] {
  return [
    makeBlock(0, 'header', 'RDT&E Project Justification'),
    makeBlock(1, 'heading', `PE ${peCode} / Project ${projectCode} / ${title}`),
    makeBlock(2, 'text', 'A. Mission Description and Budget Item Justification'),
  ];
}

function r3Header(): LayoutBlockV1[] {
  return [
    makeBlock(0, 'header', 'RDT&E Cost Analysis'),
    makeBlock(1, 'heading', 'R-3 Cost Analysis'),
    makeBlock(2, 'text', 'Performer/Contractor Table'),
  ];
}

function r4Header(): LayoutBlockV1[] {
  return [
    makeBlock(0, 'header', 'RDT&E Schedule Profile'),
    makeBlock(1, 'heading', 'R-4 Schedule Profile'),
    makeBlock(2, 'text', 'Milestone Table'),
  ];
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('r2-exhibit-segmenter', () => {
  it('segments one PE over multiple pages', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
      makePage({ page: 3, blocks: r2ContinuationHeader('0601101A') }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.kind).toBe('r2_pe_summary');
    expect(result.segments[0]?.peCode).toBe('0601101A');
    expect(result.segments[0]?.pages).toEqual([1, 2, 3]);
    expect(result.pageCoverage.get(1)).toBe(result.segments[0]?.segmentId);
    expect(result.pageCoverage.get(2)).toBe(result.segments[0]?.segmentId);
    expect(result.pageCoverage.get(3)).toBe(result.segments[0]?.segmentId);
  });

  it('segments back-to-back PEs', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research A') }),
      makePage({ page: 2, blocks: r2PeHeader('0601102A', 'Research B') }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.peCode).toBe('0601101A');
    expect(result.segments[1]?.peCode).toBe('0601102A');
    expect(result.segments[0]?.pages).toEqual([1]);
    expect(result.segments[1]?.pages).toEqual([2]);
  });

  it('handles R-2 to R-2A transition', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2aProjectHeader('0601101A', 'A1', 'Subproject Alpha') }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe('r2_pe_summary');
    expect(result.segments[0]?.peCode).toBe('0601101A');
    expect(result.segments[1]?.kind).toBe('r2a_project');
    expect(result.segments[1]?.peCode).toBe('0601101A');
    expect(result.segments[1]?.projectCode).toBe('A1');
  });

  it('handles R-2A to R-3 transition', () => {
    const pages = [
      makePage({ page: 1, blocks: r2aProjectHeader('0601101A', 'A1', 'Subproject Alpha') }),
      makePage({ page: 2, blocks: r3Header() }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe('r2a_project');
    expect(result.segments[1]?.kind).toBe('r3_page');
    expect(result.segments[1]?.peCode).toBeUndefined();
  });

  it('marks missing continuation header as unresolved', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({
        page: 2,
        blocks: [makeBlock(0, 'text', 'Some narrative text without any header')],
      }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe('r2_pe_summary');
    expect(result.segments[1]?.kind).toBe('unresolved');
    expect(result.segments[1]?.unresolvedReason).toContain(
      'no exhibit header or PE context detected',
    );
  });

  it('does not merge an evidence-less continuation page into the adjacent R-2 segment', () => {
    /* Boundary: a page whose only exhibit marker is a bare R-2 volume header
     * (no PE code, no explicit "continued" marker) is classified as an R-2
     * continuation candidate but carries NO deterministic continuation
     * evidence. It must become an explicit unresolved finding, not silently
     * inherit the adjacent PE segment. */
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({
        page: 2,
        blocks: [makeBlock(0, 'header', 'RDT&E Budget Item Justification')],
      }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe('r2_pe_summary');
    expect(result.segments[0]?.pages).toEqual([1]);
    expect(result.segments[1]?.kind).toBe('unresolved');
    expect(result.segments[1]?.unresolvedReason).toContain(
      'no deterministic continuation evidence',
    );
    /* And the resolver must not assign the orphan page a PE context. */
    const resolution = resolveR2Contexts(result);
    expect(resolution.pages[1]?.peCode).toBeUndefined();
    expect(resolution.unresolvedPages).toHaveLength(1);
  });

  it('marks conflicting PE headers as unresolved', () => {
    const pages = [
      makePage({
        page: 1,
        blocks: [
          makeBlock(0, 'header', 'RDT&E Budget Item Justification'),
          makeBlock(1, 'heading', 'PE 0601101A / Research A'),
          makeBlock(2, 'header', 'PE 0601102A / Research B'),
        ],
      }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.kind).toBe('unresolved');
    expect(result.segments[0]?.unresolvedReason).toContain('conflicting PE headers');
  });

  it('preserves printed page labels', () => {
    const pages = [
      makePage({
        page: 1,
        printedPage: 'Volume 1 - 1',
        blocks: r2PeHeader('0601101A', 'Research Project'),
      }),
      makePage({
        page: 2,
        printedPage: 'Volume 1 - 2',
        blocks: r2ContinuationHeader('0601101A'),
      }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments[0]?.printedPages).toEqual(['Volume 1 - 1', 'Volume 1 - 2']);
  });

  it('ignores repeated footer noise', () => {
    const pages = [
      makePage({
        page: 1,
        blocks: [
          ...r2PeHeader('0601101A', 'Research Project'),
          makeBlock(10, 'footer', 'PE 0601101A'),
          makeBlock(11, 'footer', 'Page 1 of 100'),
        ],
      }),
      makePage({
        page: 2,
        blocks: [
          ...r2ContinuationHeader('0601101A'),
          makeBlock(10, 'footer', 'PE 0601101A'),
          makeBlock(11, 'footer', 'Page 2 of 100'),
        ],
      }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.pages).toEqual([1, 2]);
  });

  it('is deterministic under parser output order permutation', () => {
    const page1 = makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research A') });
    const page2 = makePage({ page: 2, blocks: r2PeHeader('0601102A', 'Research B') });

    const resultA = segmentR2ExhibitPages([page1, page2]);
    const resultB = segmentR2ExhibitPages([page2, page1]);

    /* Segments are built in input order, so page assignment differs, but
     * the set of PE codes and their page coverage is deterministic. */
    const peCodesA = resultA.segments.map((s) => s.peCode).sort();
    const peCodesB = resultB.segments.map((s) => s.peCode).sort();
    expect(peCodesA).toEqual(peCodesB);

    const coverageA = [...resultA.pageCoverage.entries()].sort((a, b) => a[0] - b[0]);
    const coverageB = [...resultB.pageCoverage.entries()].sort((a, b) => a[0] - b[0]);
    expect(coverageA).toEqual(coverageB);
  });

  it('does not consume R-3 pages as R-2 narrative', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r3Header() }),
      makePage({ page: 3, blocks: r2ContinuationHeader('0601101A') }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(3);
    expect(result.segments[0]?.kind).toBe('r2_pe_summary');
    expect(result.segments[1]?.kind).toBe('r3_page');
    expect(result.segments[2]?.kind).toBe('unresolved');
    /* The R-3 page must not inherit the PE context. */
    expect(result.segments[1]?.peCode).toBeUndefined();
    /* The continuation after R-3 cannot inherit across the exhibit boundary. */
    expect(result.segments[2]?.unresolvedReason).toContain('no adjacent R-2 segment to continue');
  });

  it('handles R-4 pages embedded in the same volume', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r4Header() }),
    ];
    const result = segmentR2ExhibitPages(pages);

    expect(result.segments).toHaveLength(2);
    expect(result.segments[1]?.kind).toBe('r4_page');
    expect(result.segments[1]?.peCode).toBeUndefined();
  });
});

describe('r2-context-resolver', () => {
  it('resolves PE context for a multi-page PE segment', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);

    expect(resolution.pages).toHaveLength(2);
    expect(resolution.pages[0]?.peCode).toBe('0601101A');
    expect(resolution.pages[0]?.contextSource).toBe('explicit_header');
    expect(resolution.pages[1]?.peCode).toBe('0601101A');
    expect(resolution.pages[1]?.contextSource).toBe('deterministic_continuation');
    expect(resolution.resolvedPeCodes).toEqual(['0601101A']);
    expect(resolution.unresolvedPages).toHaveLength(0);
  });

  it('does not inherit PE context for unresolved pages', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({
        page: 2,
        blocks: [makeBlock(0, 'text', 'Orphan narrative without header')],
      }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);

    expect(resolution.pages).toHaveLength(2);
    expect(resolution.pages[0]?.peCode).toBe('0601101A');
    expect(resolution.pages[1]?.peCode).toBeUndefined();
    expect(resolution.pages[1]?.contextSource).toBe('unresolved');
    expect(resolution.unresolvedPages).toHaveLength(1);
  });

  it('resolves R-2A project context with explicit parent PE', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2aProjectHeader('0601101A', 'A1', 'Subproject Alpha') }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);

    expect(resolution.pages[1]?.peCode).toBe('0601101A');
    expect(resolution.pages[1]?.projectCode).toBe('A1');
    expect(resolution.resolvedProjectCodes).toEqual([{ peCode: '0601101A', projectCode: 'A1' }]);
  });

  it('does not resolve R-2A without explicit parent PE', () => {
    const pages = [
      makePage({
        page: 1,
        blocks: [
          makeBlock(0, 'header', 'RDT&E Project Justification'),
          makeBlock(1, 'heading', 'Project A1 / Subproject Alpha'),
        ],
      }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);

    expect(resolution.pages[0]?.peCode).toBeUndefined();
    expect(resolution.pages[0]?.contextSource).toBe('unresolved');
    expect(resolution.unresolvedPages).toHaveLength(1);
  });

  it('R-3 pages do not inherit PE context from adjacent R-2', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r3Header() }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);

    expect(resolution.pages[1]?.peCode).toBeUndefined();
    expect(resolution.pages[1]?.kind).toBe('r3_page');
  });
});

describe('r2-identity-extractor-v1', () => {
  it('extracts PE identity from R-2 segment', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);
    const result = extractR2Identities({ pages, contextResolution: resolution });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.peCode).toBe('0601101A');
    expect(result.identities[0]?.title).toBe('Research Project');
    expect(result.identities[0]?.page).toBe(1);
    expect(result.omissions).toHaveLength(0);
  });

  it('emits one identity per PE even across multiple segments', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
      makePage({ page: 3, blocks: r2aProjectHeader('0601101A', 'A1', 'Subproject Alpha') }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);
    const result = extractR2Identities({ pages, contextResolution: resolution });

    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.peCode).toBe('0601101A');
  });

  it('quarantines invalid PE codes as omissions', () => {
    const pages = [
      makePage({
        page: 1,
        blocks: [
          makeBlock(0, 'header', 'RDT&E Budget Item Justification'),
          makeBlock(1, 'heading', 'PE O6O11O1A / Research Project'),
        ],
      }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);
    const result = extractR2Identities({ pages, contextResolution: resolution });

    expect(result.identities).toHaveLength(0);
    expect(result.omissions.length).toBeGreaterThan(0);
  });

  it('produces omissions for unresolved pages', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research Project') }),
      makePage({
        page: 2,
        blocks: [makeBlock(0, 'text', 'Orphan narrative')],
      }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);
    const result = extractR2Identities({ pages, contextResolution: resolution });

    expect(result.identities).toHaveLength(1);
    expect(result.omissions).toHaveLength(1);
    expect(result.omissions[0]?.page).toBe(2);
    expect(result.omissions[0]?.reason).toContain('no exhibit header or PE context');
  });

  it('extracts title from heading containing PE code', () => {
    const pages = [
      makePage({
        page: 1,
        blocks: [
          makeBlock(0, 'header', 'RDT&E Budget Item Justification'),
          makeBlock(1, 'heading', 'PE 0601101A / Advanced Materials Research'),
        ],
      }),
    ];
    const segmentation = segmentR2ExhibitPages(pages);
    const resolution = resolveR2Contexts(segmentation);
    const result = extractR2Identities({ pages, contextResolution: resolution });

    expect(result.identities[0]?.title).toBe('Advanced Materials Research');
  });

  it('is deterministic under page order permutation', () => {
    const page1 = makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research A') });
    const page2 = makePage({ page: 2, blocks: r2PeHeader('0601102A', 'Research B') });

    const resultA = extractR2Identities({
      pages: [page1, page2],
      contextResolution: resolveR2Contexts(segmentR2ExhibitPages([page1, page2])),
    });
    const resultB = extractR2Identities({
      pages: [page2, page1],
      contextResolution: resolveR2Contexts(segmentR2ExhibitPages([page2, page1])),
    });

    const sortIdentities = (r: typeof resultA) =>
      [...r.identities].sort((a, b) => a.peCode.localeCompare(b.peCode));
    expect(sortIdentities(resultA)).toEqual(sortIdentities(resultB));
  });
});

describe('acceptance criteria', () => {
  it('every selected page is assigned to one segment or one explicit unresolved finding', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research A') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
      makePage({ page: 3, blocks: r2PeHeader('0601102A', 'Research B') }),
      makePage({ page: 4, blocks: r3Header() }),
      makePage({ page: 5, blocks: [makeBlock(0, 'text', 'orphan')] }),
    ];
    const result = segmentR2ExhibitPages(pages);

    for (const page of pages) {
      expect(result.pageCoverage.has(page.page)).toBe(true);
    }
    expect(result.pageCoverage.size).toBe(pages.length);
  });

  it('no page belongs to two selected PE segments', () => {
    const pages = [
      makePage({ page: 1, blocks: r2PeHeader('0601101A', 'Research A') }),
      makePage({ page: 2, blocks: r2ContinuationHeader('0601101A') }),
      makePage({ page: 3, blocks: r2PeHeader('0601102A', 'Research B') }),
    ];
    const result = segmentR2ExhibitPages(pages);

    const pageToSegments = new Map<number, string[]>();
    for (const segment of result.segments) {
      for (const page of segment.pages) {
        const existing = pageToSegments.get(page) ?? [];
        existing.push(segment.segmentId);
        pageToSegments.set(page, existing);
      }
    }

    for (const [page, segmentIds] of pageToSegments) {
      expect(segmentIds).toHaveLength(1);
    }
  });
});

describe('Phase 10B-16 Part D -- structured-evidence-first, body-text fallback', () => {
  /* Real DoD budget PDFs (confirmed against the FY2024 Army R-2 Volume 1
   * BA1 document) carry their exhibit-type boilerplate, PE number/title,
   * and appropriation/BA context entirely inside ordinary body-text lines
   * -- not inside any block the engine classifies as 'header' or 'heading'.
   * Before this fix, `classifyPage()` computed `allText` (including body
   * text) but never read it, so these real pages always fell through to
   * 'unresolved'. */
  function bodyOnlyR2Page(peCode: string, title: string, page: number): ParserPageResultV1 {
    return makePage({
      page,
      blocks: [
        makeBlock(0, 'text', 'UNCLASSIFIED'),
        makeBlock(1, 'text', 'Exhibit R-2 RDT&E Budget Item Justification: PB 2024 Army'),
        makeBlock(
          2,
          'text',
          `Appropriation/Budget Activity R-1 Program Element (Number/Name) ` +
            `2040: Research, Development, Test & Evaluation, Army BA 1: Basic PE ${peCode} ${title}`,
        ),
        makeBlock(3, 'text', 'Total Program Element - 358.521 391.642 296.670 - 296.670'),
      ],
    });
  }

  it('resolves a real-shaped R-2 page to its PE code from body text alone when no header/heading evidence exists', () => {
    const page = bodyOnlyR2Page('0601102A', 'Defense Research Sciences', 43);
    const result = segmentR2ExhibitPages([page]);
    const classification = result.classifications[0]!;
    expect(classification.kind).toBe('r2_pe_summary');
    expect(classification.headerPeCodes).toEqual(['0601102A']);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]!.peCode).toBe('0601102A');
  });

  it('does NOT let body-text scanning override an already-resolved structured header/heading (structured evidence wins)', () => {
    const page = makePage({
      page: 1,
      blocks: [
        ...r2PeHeader('0601101A', 'Research A'),
        // A stray, unrelated PE code mentioned in ordinary narrative body
        // text on the same page must never contaminate the page's
        // already-resolved structured identity.
        makeBlock(3, 'text', 'See also the related discussion of PE 0699999Z elsewhere in this volume.'),
      ],
    });
    const result = segmentR2ExhibitPages([page]);
    const classification = result.classifications[0]!;
    expect(classification.kind).toBe('r2_pe_summary');
    expect(classification.headerPeCodes).toEqual(['0601101A']);
  });

  it('does NOT falsely classify a narrative/multi-PE listing page as a valid R-2 segment (negative control)', () => {
    // Modeled on the real Army R-2 volume's "Program Element/Project
    // Restructures" summary table (physical pages 7-8): many distinct PE
    // codes on one page, no R-2 exhibit-type boilerplate anywhere.
    const page = makePage({
      page: 7,
      blocks: [
        makeBlock(0, 'text', '05 0604818A / DD1 Unified Network Technology Trans & Integ (UNTTI)'),
        makeBlock(1, 'text', '05 0605206A / DG3 CI and HUMINT Equipment Program-Army (CIHEP-A)'),
        makeBlock(2, 'text', 'Program Element/Project Restructures:'),
      ],
    });
    const result = segmentR2ExhibitPages([page]);
    const classification = result.classifications[0]!;
    expect(classification.kind).toBe('unresolved');
    expect(classification.reason).toMatch(/conflicting PE headers/);
  });

  it('does NOT falsely classify an ordinary narrative body paragraph with no exhibit or PE evidence (negative control)', () => {
    const page = makePage({
      page: 44,
      blocks: [
        makeBlock(
          0,
          'text',
          'This Program Element builds fundamental scientific knowledge contributing to the ' +
            'sustainment of United States scientific and technological superiority in land warfighting ' +
            'capability and to solving military problems related to long-term national security needs.',
        ),
      ],
    });
    const result = segmentR2ExhibitPages([page]);
    const classification = result.classifications[0]!;
    expect(classification.kind).toBe('unresolved');
    expect(classification.headerPeCodes).toEqual([]);
  });

  it('does not route a wrong-PE/different document as a valid continuation of an unrelated prior segment', () => {
    const pages = [
      bodyOnlyR2Page('0601102A', 'Defense Research Sciences', 43),
      // A DIFFERENT, unrelated PE's own R-2 PE-summary page (body-text
      // only) immediately following -- must start its OWN new segment
      // with its own correct PE code, never silently inherit or merge
      // into the preceding, unrelated PE's segment.
      bodyOnlyR2Page('0601103A', 'Some Other Program', 126),
    ];
    const result = segmentR2ExhibitPages(pages);
    expect(result.segments).toHaveLength(2);
    const byPage = new Map(result.segments.map((s) => [s.pages[0], s]));
    expect(byPage.get(43)?.peCode).toBe('0601102A');
    expect(byPage.get(126)?.peCode).toBe('0601103A');
  });

  /* Phase 10B-21A Part 5: `non_semantic` false-positive regression coverage.
   * A real Army FY2024 R-2 volume's front matter (cover, blanks, tables of
   * contents, appropriation-language boilerplate, roman-numeral-paginated
   * index sections) is correctly classified `non_semantic` -- but a page
   * that genuinely IS R-2 PE content must never be reclassified away from
   * its real exhibit type merely because it happens to mention a phrase
   * like "Table of Contents" or a roman numeral somewhere in its own body
   * text. Every positive case here is paired with the negative control that
   * proves the same phrase, on a page with NO real exhibit header, DOES
   * classify as non_semantic. */
  describe('non_semantic classification: proven true positives and false-positive negative controls', () => {
    it('classifies a genuinely blank separator page as non_semantic', () => {
      const page = makePage({ page: 2, blocks: [], text: '' });
      const result = segmentR2ExhibitPages([page]);
      expect(result.classifications[0]!.kind).toBe('non_semantic');
      expect(result.segments[0]!.kind).toBe('non_semantic');
      // Part E: the page is still accounted for in the coverage ledger.
      expect(result.pageCoverage.get(2)).toBeDefined();
    });

    it('classifies a real document-level Table of Contents page as non_semantic', () => {
      const page = makePage({
        page: 3,
        blocks: [
          makeBlock(0, 'heading', 'Volume 1a Table of Contents'),
          makeBlock(
            1,
            'text',
            'Introduction and Explanation of Contents....................Volume 1a - ii',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      expect(result.classifications[0]!.kind).toBe('non_semantic');
    });

    it('classifies a real roman-numeral-paginated index page (no exhibit header) as non_semantic', () => {
      const page = makePage({
        page: 15,
        text: 'Volume 1a - xi',
        blocks: [makeBlock(0, 'footer', 'Volume 1a - xi')],
      });
      const result = segmentR2ExhibitPages([page]);
      expect(result.classifications[0]!.kind).toBe('non_semantic');
    });

    it('does NOT reclassify a genuine R-2 PE page as non_semantic merely because its narrative body mentions "Table of Contents" (false-positive negative control)', () => {
      const page = makePage({
        page: 43,
        blocks: [
          ...r2PeHeader('0601102A', 'Defense Research Sciences'),
          makeBlock(
            3,
            'text',
            'Related programs across the Army RDT&E portfolio are cross-referenced in the ' +
              'Program Element Table of Contents at the front of this volume.',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      const classification = result.classifications[0]!;
      expect(classification.kind).toBe('r2_pe_summary');
      expect(classification.headerPeCodes).toContain('0601102A');
    });

    it('does NOT reclassify a genuine R-2 PE page as non_semantic merely because its narrative body mentions a roman-numeral volume reference (false-positive negative control)', () => {
      const page = makePage({
        page: 43,
        blocks: [
          ...r2PeHeader('0601102A', 'Defense Research Sciences'),
          makeBlock(
            3,
            'text',
            'See Volume 1a - iv for the full list of program element restructures affecting this line.',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      const classification = result.classifications[0]!;
      expect(classification.kind).toBe('r2_pe_summary');
      expect(classification.headerPeCodes).toContain('0601102A');
    });

    it('keeps a STRUCTURED-header page with a genuine PE-code conflict as unresolved (for human review), even when its body text also matches a front-matter phrase (2nd-round independent-review regression: the !hasConflict veto must not override an unconditionally-protected structured header)', () => {
      const page = makePage({
        page: 44,
        blocks: [
          ...r2PeHeader('0601102A', 'Defense Research Sciences'),
          // A second, distinct PE code inside a structured header/footer
          // block -- e.g. a cross-reference or restructuring note on an
          // otherwise real exhibit page -- makes this page genuinely
          // ambiguous (Class 5), not provably non-semantic. It must stay
          // 'unresolved' and blocking, never be silently absorbed into
          // non_semantic just because the SAME page's body text also
          // happens to mention "Table of Contents".
          makeBlock(3, 'footer', 'formerly PE 0601103A'),
          makeBlock(
            4,
            'text',
            'Cross-referenced in the Program Element Table of Contents at the front of this volume.',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      const classification = result.classifications[0]!;
      expect(classification.kind).toBe('unresolved');
      expect(classification.reason).toMatch(/conflicting PE headers/);
      expect(classification.headerPeCodes).toEqual(
        expect.arrayContaining(['0601102A', '0601103A']),
      );
    });

    it('does NOT reclassify a genuine R-2A project page as non_semantic merely because its narrative body mentions "Table of Contents" (false-positive negative control)', () => {
      const page = makePage({
        page: 51,
        blocks: [
          ...r2aProjectHeader('0601102A', 'H09', 'In-House Laboratory Independent Research'),
          makeBlock(
            3,
            'text',
            'Refer to the Table of Contents for the parent program element summary.',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      const classification = result.classifications[0]!;
      expect(classification.kind).toBe('r2a_project');
    });

    it('does NOT reclassify a BODY-TEXT-ONLY (no structured header/heading block at all) genuine R-2 PE page as non_semantic merely because it mentions "Table of Contents" or a roman-numeral cross-reference (independent-review Finding 1 regression)', () => {
      // Real DoD budget PDFs sometimes carry the exhibit header/PE code
      // entirely inside plain 'text' blocks (Phase 10B-16 Part D,
      // `bodyOnlyR2Page` above) -- `hasStructuredExhibitSignal` is FALSE for
      // these pages even though `isR2` still resolves TRUE via the body-text
      // fallback. Gating the front-matter signals on
      // `!hasStructuredExhibitSignal` alone (rather than the fully-resolved
      // `!hasAnyExhibitSignal`) would have let this exact page be
      // reclassified away with zero omission recorded -- a silent loss of a
      // real program element, not merely a missed positive.
      const page = bodyOnlyR2Page('0601102A', 'Defense Research Sciences', 43);
      page.blocks.push(
        makeBlock(
          4,
          'text',
          'Cross-referenced in the Program Element Table of Contents; see also Volume 1a - iv ' +
            'for the full list of program element restructures affecting this line.',
        ),
      );
      const result = segmentR2ExhibitPages([page]);
      const classification = result.classifications[0]!;
      expect(classification.kind).toBe('r2_pe_summary');
      expect(classification.headerPeCodes).toContain('0601102A');

      const resolution = resolveR2Contexts(result);
      const identities = extractR2Identities({ pages: [page], contextResolution: resolution });
      expect(identities.identities).toHaveLength(1);
      expect(identities.identities[0]!.peCode).toBe('0601102A');
      expect(identities.omissions).toHaveLength(0);
    });

    it('DOES classify an ordinary body paragraph mentioning "Table of Contents" as non_semantic when there is no exhibit header at all (contrasting positive case)', () => {
      const page = makePage({
        page: 3,
        blocks: [
          makeBlock(
            0,
            'text',
            'Refer to the Table of Contents at the front of this volume for the full program listing.',
          ),
        ],
      });
      const result = segmentR2ExhibitPages([page]);
      expect(result.classifications[0]!.kind).toBe('non_semantic');
    });
  });
});
