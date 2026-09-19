/**
 * r2-identity-extractor-r3r4-boundary.spec — Phase 10B-41 regression suite.
 *
 * Covers the R-3/R-4 exhibit-page boundary defect: r2-exhibit-segmenter.ts
 * never attaches a peCode to r3_page/r4_page segments by design, but
 * r2-context-resolver.ts still labels them contextSource='explicit_header'.
 * Before the fix, extractR2Identities had no `kind`-based skip, so every
 * R-3/R-4 page fell through to the `missing_pe_context` omission branch even
 * though there is no R-2 identity to omit there at all -- this produced 207
 * spurious blocking omissions across BA4A's 19 PEs and forced
 * COMPLETENESS_RULE to FAIL.
 *
 * These tests call extractR2Identities directly with hand-built
 * ParserPageResultV1 + R2ContextResolutionResult fixtures -- the function's
 * inputs are pure data, so no full parser pipeline is needed.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { extractR2Identities } from './r2-identity-extractor-v1.js';
import type { R2ContextResolutionResult, R2ResolvedPage } from './r2-context-resolver.js';

function makePage(page: number, text = ''): ParserPageResultV1 {
  return {
    page,
    text,
    blocks: [],
    tables: [],
    images: [],
    evidencePrecision: 'page_only',
    warnings: [],
  };
}

function makeResolvedPage(overrides: Partial<R2ResolvedPage> & Pick<R2ResolvedPage, 'page' | 'kind'>): R2ResolvedPage {
  return {
    segmentId: `seg-${overrides.page}`,
    contextSource: 'explicit_header',
    evidence: [],
    ...overrides,
  };
}

function contextResult(pages: R2ResolvedPage[]): R2ContextResolutionResult {
  return {
    pages,
    resolvedPeCodes: [],
    resolvedProjectCodes: [],
    unresolvedPages: [],
  };
}

describe('extractR2Identities — Phase 10B-41 R-3/R-4 boundary', () => {
  it('RED/GREEN: an r3_page with contextSource=explicit_header and no peCode produces NO omission (matches real BA4A page 304 shape)', () => {
    const resolvedPage = makeResolvedPage({
      page: 304,
      kind: 'r3_page',
      contextSource: 'explicit_header',
      peCode: undefined,
    });
    const result = extractR2Identities({
      pages: [makePage(304, 'Exhibit R-3, Project Cost Analysis')],
      contextResolution: contextResult([resolvedPage]),
    });

    expect(result.omissions).toEqual([]);
    expect(result.identities).toEqual([]);
  });

  it('RED/GREEN: an r4_page with contextSource=explicit_header and no peCode produces NO omission', () => {
    const resolvedPage = makeResolvedPage({
      page: 512,
      kind: 'r4_page',
      contextSource: 'explicit_header',
      peCode: undefined,
    });
    const result = extractR2Identities({
      pages: [makePage(512, 'Exhibit R-4, Schedule Profile')],
      contextResolution: contextResult([resolvedPage]),
    });

    expect(result.omissions).toEqual([]);
    expect(result.identities).toEqual([]);
  });

  it('r3_page/r4_page skip applies regardless of position relative to real R-2 pages', () => {
    const pages: R2ResolvedPage[] = [
      makeResolvedPage({ page: 1, kind: 'r2_pe_summary', contextSource: 'explicit_header', peCode: '0604017A' }),
      makeResolvedPage({ page: 2, kind: 'r3_page', contextSource: 'explicit_header', peCode: undefined }),
      makeResolvedPage({ page: 3, kind: 'r4_page', contextSource: 'explicit_header', peCode: undefined }),
    ];
    const result = extractR2Identities({
      pages: pages.map((p) => makePage(p.page)),
      contextResolution: contextResult(pages),
    });

    expect(result.omissions).toEqual([]);
    expect(result.identities).toHaveLength(1);
    expect(result.identities[0]?.peCode).toBe('0604017A');
  });

  it('negative control: a genuinely unresolved r2_continuation page still surfaces its real omission (fix must not blanket-suppress)', () => {
    const resolvedPage = makeResolvedPage({
      page: 7,
      kind: 'r2_continuation',
      contextSource: 'unresolved',
      unresolvedReason: 'continuation segment lacks inherited PE context',
      peCode: undefined,
    });
    const result = extractR2Identities({
      pages: [makePage(7)],
      contextResolution: contextResult([resolvedPage]),
    });

    expect(result.omissions).toEqual([
      expect.objectContaining({
        page: 7,
        reason: 'continuation segment lacks inherited PE context',
      }),
    ]);
  });

  it('negative control: a non-r3/r4 page with explicit_header but no peCode still reports missing_pe_context (defensive fallback preserved)', () => {
    const resolvedPage = makeResolvedPage({
      page: 9,
      kind: 'r2_pe_summary',
      contextSource: 'explicit_header',
      peCode: undefined,
    });
    const result = extractR2Identities({
      pages: [makePage(9)],
      contextResolution: contextResult([resolvedPage]),
    });

    expect(result.omissions).toEqual([
      expect.objectContaining({ page: 9, reason: 'missing_pe_context' }),
    ]);
  });

  it('negative control: non_semantic and r1_summary pages remain silently skipped (unchanged by this fix)', () => {
    const pages: R2ResolvedPage[] = [
      makeResolvedPage({ page: 1, kind: 'non_semantic', contextSource: 'non_semantic', peCode: undefined }),
      makeResolvedPage({ page: 2, kind: 'r1_summary', contextSource: 'r1_summary', peCode: undefined }),
    ];
    const result = extractR2Identities({
      pages: pages.map((p) => makePage(p.page)),
      contextResolution: contextResult(pages),
    });

    expect(result.omissions).toEqual([]);
    expect(result.identities).toEqual([]);
  });
});
