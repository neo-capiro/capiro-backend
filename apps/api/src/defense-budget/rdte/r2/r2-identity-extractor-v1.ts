/**
 * r2-identity-extractor-v1 — extract PE identity assertions from segmented
 * R-2/R-2A pages.
 *
 * Pure module. Consumes segmentation + context resolution output; never
 * invokes a parser, never writes to a database.
 *
 * Identity rules:
 *   - Only valid R-2 PE headers produce program_element_identity assertions;
 *   - R-2 identity does NOT create a new PE outside the R-1 catalog silently —
 *     the assertion is emitted with the same identity semantics as R-1;
 *   - Invalid or conflicting PE codes are quarantined as omissions, never
 *     coerced into valid-looking codes.
 */
import type { ParserPageResultV1 } from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';
import type { R2ContextResolutionResult, R2ResolvedPage } from './r2-context-resolver.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface R2PeIdentity {
  peCode: string;
  title: string;
  page: number;
  printedPage?: string;
  segmentId: string;
  contextSource: 'explicit_header' | 'deterministic_continuation';
  appropriation?: string;
  budgetActivity?: string;
}

export interface R2IdentityExtractionOmission {
  page: number;
  segmentId: string;
  reason: string;
  rawText: string;
}

export interface R2IdentityExtractionResult {
  identities: R2PeIdentity[];
  omissions: R2IdentityExtractionOmission[];
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract PE identities from resolved R-2/R-2A pages.
 *
 * Only pages with explicit or deterministically-continued PE context produce
 * identities. Unresolved pages produce omissions.
 */
export function extractR2Identities(input: {
  pages: readonly ParserPageResultV1[];
  contextResolution: R2ContextResolutionResult;
}): R2IdentityExtractionResult {
  const { pages, contextResolution } = input;
  const identities: R2PeIdentity[] = [];
  const omissions: R2IdentityExtractionOmission[] = [];

  /* Build a lookup from page number to parser page for title extraction. */
  const pageMap = new Map<number, ParserPageResultV1>();
  for (const page of pages) {
    pageMap.set(page.page, page);
  }

  /* Track which PEs have already had an identity emitted to avoid duplicates
   * when a PE spans multiple segments (e.g. summary + continuation). */
  const emittedPeCodes = new Set<string>();

  for (const resolvedPage of contextResolution.pages) {
    const parserPage = pageMap.get(resolvedPage.page);

    if (resolvedPage.contextSource === 'unresolved') {
      omissions.push({
        page: resolvedPage.page,
        segmentId: resolvedPage.segmentId,
        reason: resolvedPage.unresolvedReason ?? 'unresolved_context',
        rawText: parserPage?.text?.slice(0, 200) ?? '',
      });
      continue;
    }

    if (resolvedPage.peCode == null) {
      omissions.push({
        page: resolvedPage.page,
        segmentId: resolvedPage.segmentId,
        reason: 'missing_pe_context',
        rawText: parserPage?.text?.slice(0, 200) ?? '',
      });
      continue;
    }

    if (!isValidPeCode(resolvedPage.peCode)) {
      omissions.push({
        page: resolvedPage.page,
        segmentId: resolvedPage.segmentId,
        reason: 'invalid_pe_code',
        rawText: resolvedPage.peCode,
      });
      continue;
    }

    /* Only emit one identity per PE code per volume. */
    if (emittedPeCodes.has(resolvedPage.peCode)) {
      continue;
    }
    emittedPeCodes.add(resolvedPage.peCode);

    const title = extractPeTitle(parserPage, resolvedPage);
    identities.push({
      peCode: resolvedPage.peCode,
      title,
      page: resolvedPage.page,
      ...(resolvedPage.printedPage != null ? { printedPage: resolvedPage.printedPage } : {}),
      segmentId: resolvedPage.segmentId,
      contextSource: resolvedPage.contextSource,
    });
  }

  return { identities, omissions };
}

/* ------------------------------------------------------------------ */
/* Title extraction                                                    */
/* ------------------------------------------------------------------ */

/**
 * Extract the PE title from a page. Looks for:
 *   1. A heading block containing the PE code;
 *   2. The first heading block on the page;
 *   3. Fallback: "PE {code}".
 */
function extractPeTitle(
  page: ParserPageResultV1 | undefined,
  resolvedPage: R2ResolvedPage,
): string {
  if (page == null) {
    return `PE ${resolvedPage.peCode}`;
  }

  const peCode = resolvedPage.peCode!;

  /* Look for a heading that contains the PE code. */
  for (const block of page.blocks) {
    if (block.blockType !== 'heading' && block.blockType !== 'header') continue;
    const text = block.text.trim();
    if (text.includes(peCode)) {
      /* Strip the PE code and common prefixes to get the title. */
      const stripped = text
        .replace(new RegExp(`\\bPE\\s+${peCode}\\b[\\s:/\\-]*`, 'i'), '')
        .replace(new RegExp(`\\b${peCode}\\b[\\s:/\\-]*`, 'i'), '')
        .trim();
      if (stripped.length > 0) {
        return stripped;
      }
      return text;
    }
  }

  /* First heading on the page. */
  const firstHeading = page.blocks.find(
    (b) => b.blockType === 'heading' && b.text.trim().length > 0,
  );
  if (firstHeading != null) {
    return firstHeading.text.trim();
  }

  return `PE ${peCode}`;
}
