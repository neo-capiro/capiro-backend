/**
 * r2-context-resolver — resolve PE/project context for every segmented page.
 *
 * Pure module. Consumes segmentation output; never invokes a parser.
 *
 * Boundary rules enforced here:
 *   - A new explicit PE header ends the prior PE segment (handled by segmenter);
 *   - An R-2A project must retain its explicit parent PE;
 *   - A continuation page may inherit context only when deterministic
 *     adjacent-page evidence supports it;
 *   - A page with two conflicting PE headers is unresolved/review-required;
 *   - A page without resolvable PE context must NOT inherit the previous PE
 *     merely because it is adjacent;
 *   - R-3/R-4 pages must not be consumed as R-2 narrative pages.
 */
import type { R2Segment, R2SegmentationResult } from './r2-exhibit-segmenter.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface R2ResolvedPage {
  page: number;
  printedPage?: string;
  segmentId: string;
  kind: R2Segment['kind'];
  /** Resolved PE context (undefined when unresolved). */
  peCode?: string;
  /** Resolved project context (undefined for PE-level or unresolved). */
  projectCode?: string;
  /** How the context was established. */
  contextSource: 'explicit_header' | 'deterministic_continuation' | 'unresolved';
  /** Evidence strings supporting the resolution. */
  evidence: string[];
  /** For unresolved pages: why resolution failed. */
  unresolvedReason?: string;
}

export interface R2ContextResolutionResult {
  pages: R2ResolvedPage[];
  /** All PE codes that appear in resolved segments. */
  resolvedPeCodes: string[];
  /** All project codes that appear in resolved segments. */
  resolvedProjectCodes: Array<{ peCode: string; projectCode: string }>;
  /** Pages that could not be resolved. */
  unresolvedPages: R2ResolvedPage[];
}

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

/**
 * Resolve PE/project context for every page in the segmentation result.
 *
 * The resolver validates segment-level context and produces a flat page-level
 * view that downstream extractors can consume without guessing.
 */
export function resolveR2Contexts(segmentation: R2SegmentationResult): R2ContextResolutionResult {
  const pages: R2ResolvedPage[] = [];
  const resolvedPeCodes = new Set<string>();
  const resolvedProjectCodes: Array<{ peCode: string; projectCode: string }> = [];
  const unresolvedPages: R2ResolvedPage[] = [];

  for (const segment of segmentation.segments) {
    const segmentPages = segment.pages.slice().sort((a, b) => a - b);

    for (const pageNum of segmentPages) {
      const printedPage = segmentation.classifications.find((c) => c.page === pageNum)?.printedPage;
      const pageContextSource = segment.pageContextSources.get(pageNum) ?? 'explicit_header';

      const resolved: R2ResolvedPage = {
        page: pageNum,
        ...(printedPage != null ? { printedPage } : {}),
        segmentId: segment.segmentId,
        kind: segment.kind,
        contextSource: 'unresolved',
        evidence: [...segment.contextEvidence],
      };

      switch (segment.kind) {
        case 'r2_pe_summary': {
          if (segment.peCode != null) {
            resolved.peCode = segment.peCode;
            resolved.contextSource = pageContextSource;
            resolvedPeCodes.add(segment.peCode);
          } else {
            resolved.unresolvedReason = 'R-2 PE summary segment lacks PE code';
            unresolvedPages.push(resolved);
          }
          break;
        }

        case 'r2_continuation': {
          if (segment.peCode != null) {
            resolved.peCode = segment.peCode;
            resolved.contextSource = pageContextSource;
            resolvedPeCodes.add(segment.peCode);
          } else {
            resolved.unresolvedReason =
              segment.unresolvedReason ?? 'continuation segment lacks inherited PE context';
            unresolvedPages.push(resolved);
          }
          break;
        }

        case 'r2a_project': {
          if (segment.peCode != null && segment.projectCode != null) {
            resolved.peCode = segment.peCode;
            resolved.projectCode = segment.projectCode;
            resolved.contextSource = 'explicit_header';
            resolvedPeCodes.add(segment.peCode);
            resolvedProjectCodes.push({
              peCode: segment.peCode,
              projectCode: segment.projectCode,
            });
          } else if (segment.peCode != null) {
            resolved.peCode = segment.peCode;
            resolved.contextSource = 'explicit_header';
            resolvedPeCodes.add(segment.peCode);
            resolved.unresolvedReason = 'R-2A segment lacks project code';
            unresolvedPages.push(resolved);
          } else {
            resolved.unresolvedReason =
              segment.unresolvedReason ?? 'R-2A segment lacks parent PE context';
            unresolvedPages.push(resolved);
          }
          break;
        }

        case 'r3_page':
        case 'r4_page': {
          /* R-3/R-4 pages carry their own exhibit context; they do not
           * inherit PE context from adjacent R-2 segments. */
          resolved.contextSource = 'explicit_header';
          if (segment.peCode != null) {
            resolved.peCode = segment.peCode;
            resolvedPeCodes.add(segment.peCode);
          }
          break;
        }

        case 'unresolved': {
          resolved.unresolvedReason = segment.unresolvedReason ?? 'unresolved segment';
          unresolvedPages.push(resolved);
          break;
        }
      }

      pages.push(resolved);
    }
  }

  return {
    pages,
    resolvedPeCodes: [...resolvedPeCodes].sort(),
    resolvedProjectCodes,
    unresolvedPages,
  };
}
