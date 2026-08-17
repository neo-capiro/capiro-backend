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
