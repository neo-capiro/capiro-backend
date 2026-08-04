/**
 * r2-narrative-extractor-v1 — extract complete PE-level narrative from
 * segmented R-2 pages.
 *
 * For every PE with an R-2 exhibit, extracts:
 *   - mission description and budget item justification;
 *   - description/rationale;
 *   - accomplishments;
 *   - plans;
 *   - schedule notes;
 *   - other labeled narrative sections.
 *
 * Cleaning is deterministic only: header/footer removal, whitespace
 * normalization, dehyphenation, continuation joining within one section.
 * No paraphrase, no acronym rewriting, no gap filling, no cross-PE joining.
 *
 * Pure module. Never invokes a parser, never calls LlamaParse, never writes
 * to a database.
 */
import type {
  LayoutBlockV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import type { NarrativeTypeV1 } from '../../contracts/extraction-artifact-v1.js';
import type { R2ContextResolutionResult, R2ResolvedPage } from './r2-context-resolver.js';
import {
  normalizeR2SectionLabel,
  isLikelySectionHeading,
  type R2SectionLabel,
} from './r2-section-normalizer.js';

/* ------------------------------------------------------------------ */
/* Output types                                                        */
/* ------------------------------------------------------------------ */

export interface R2NarrativeSection {
  peCode: string;
  narrativeType: NarrativeTypeV1;
  /** Exact section label as printed. */
  sectionLabel: string;
  /** Cleaned narrative text. */
  text: string;
  /** Raw text before cleaning (for provenance). */
  rawText: string;
  /** Physical pages contributing to this section. */
  pages: number[];
  /** Printed page labels. */
  printedPages: string[];
}

export interface R2NarrativeOmission {
  peCode: string;
  page: number;
  reason: string;
  rawText: string;
}

export interface R2NarrativeExtractionResult {
  sections: R2NarrativeSection[];
  omissions: R2NarrativeOmission[];
}

/* ------------------------------------------------------------------ */
/* Block filtering                                                     */
/* ------------------------------------------------------------------ */

/** Block types that are page furniture, not narrative content. */
const FURNITURE_TYPES: ReadonlySet<string> = new Set([
  'header',
  'footer',
  'caption',
  'image',
  'table',
]);

/**
 * Check whether a block is likely a repeated page header/footer.
 * These are identified by blockType AND by content patterns.
 */
function isRepeatedFurniture(block: LayoutBlockV1, peCode?: string): boolean {
  if (FURNITURE_TYPES.has(block.blockType)) return true;

  const text = block.text.trim();
  if (text === '') return true;

  /* Volume/exhibit headers like "RDT&E Budget Item Justification R-2" */
  if (/^RDT&E\s+(Budget|Project|Cost|Schedule)/i.test(text)) return true;
  if (/^R-[234]A?\s/i.test(text)) return true;

  /* Page-number-only lines */
  if (/^\d+$/.test(text)) return true;

  /* PE header line (contains PE code + title on one line) */
  if (peCode != null && text.includes(peCode) && text.length < 200) return true;

  /* All-caps footer noise */
  if (/^[A-Z\s\d.,;:()\-/]+$/.test(text) && text.length < 100) return true;

  return false;
}

/* ------------------------------------------------------------------ */
/* Text cleaning                                                       */
/* ------------------------------------------------------------------ */

/**
 * Deterministic text cleaning:
 *   1. Normalize whitespace (collapse multiple spaces/newlines).
 *   2. Dehyphenate line-break hyphens where evidence is clear.
 *   3. Join continuation lines within one section.
 */
function cleanNarrativeText(rawLines: string[]): string {
  /* Join lines, handling hyphenated word breaks. */
  let text = rawLines.join('\n');

  /* Dehyphenation: word ending in hyphen at line break + lowercase start
   * on next line → join without hyphen. */
  text = text.replace(/(\w)-\n(\w)/g, '$1$2');

  /* Normalize whitespace: collapse multiple newlines to paragraph breaks,
   * collapse multiple spaces to single space. */
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/[ \t]+/g, ' ');

  /* Trim each line. */
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');

  /* Remove leading/trailing whitespace. */
  text = text.trim();

  return text;
}

/* ------------------------------------------------------------------ */
/* Extractor                                                           */
/* ------------------------------------------------------------------ */

/**
 * Extract narrative sections from R-2 PE summary and continuation pages.
 *
 * Input: all pages + context resolution from WS E.
 * Only pages classified as r2_pe_summary or r2_continuation with a resolved
 * PE code are processed.
 */
export function extractR2Narrative(input: {
  pages: readonly ParserPageResultV1[];
  contextResolution: R2ContextResolutionResult;
}): R2NarrativeExtractionResult {
  const { pages, contextResolution } = input;
  const sections: R2NarrativeSection[] = [];
  const omissions: R2NarrativeOmission[] = [];

  /* Group resolved pages by PE code. */
  const pePagesMap = new Map<string, R2ResolvedPage[]>();
  for (const rp of contextResolution.pages) {
    if (rp.peCode == null) continue;
    if (rp.kind !== 'r2_pe_summary' && rp.kind !== 'r2_continuation') continue;
    const existing = pePagesMap.get(rp.peCode) ?? [];
    existing.push(rp);
    pePagesMap.set(rp.peCode, existing);
  }

  const pageMap = new Map<number, ParserPageResultV1>();
  for (const p of pages) {
    pageMap.set(p.page, p);
  }

  for (const [peCode, resolvedPages] of pePagesMap) {
    const sortedPages = [...resolvedPages].sort((a, b) => a.page - b.page);
    const peSections = extractPeNarrativeSections(peCode, sortedPages, pageMap);
    sections.push(...peSections.sections);
    omissions.push(...peSections.omissions);
  }

  return { sections, omissions };
}

/* ------------------------------------------------------------------ */
/* Per-PE section extraction                                           */
/* ------------------------------------------------------------------ */

function extractPeNarrativeSections(
  peCode: string,
  resolvedPages: R2ResolvedPage[],
  pageMap: Map<number, ParserPageResultV1>,
): { sections: R2NarrativeSection[]; omissions: R2NarrativeOmission[] } {
  const sections: R2NarrativeSection[] = [];
  const omissions: R2NarrativeOmission[] = [];

  /* Collect all content blocks across the PE's pages, tracking current section. */
  let currentSection: R2SectionLabel | null = null;
  let currentLines: string[] = [];
  let currentRawLines: string[] = [];
  let currentPages: number[] = [];
  let currentPrintedPages: string[] = [];

  function flushSection(): void {
    if (currentSection == null || currentLines.length === 0) {
      currentSection = null;
      currentLines = [];
      currentRawLines = [];
      currentPages = [];
      currentPrintedPages = [];
      return;
    }

    const cleanedText = cleanNarrativeText(currentLines);
    const rawText = currentRawLines.join('\n');

    if (cleanedText.length > 0) {
      sections.push({
        peCode,
        narrativeType: currentSection.narrativeType,
        sectionLabel: currentSection.exactLabel,
        text: cleanedText,
        rawText,
        pages: [...new Set(currentPages)].sort((a, b) => a - b),
        printedPages: [...new Set(currentPrintedPages)],
      });
    }

    currentSection = null;
    currentLines = [];
    currentRawLines = [];
    currentPages = [];
    currentPrintedPages = [];
  }

  for (const rp of resolvedPages) {
    const page = pageMap.get(rp.page);
    if (page == null) continue;

    for (const block of page.blocks) {
      /* Skip furniture blocks. */
      if (isRepeatedFurniture(block, peCode)) continue;

      const text = block.text.trim();
      if (text === '') continue;

      /* Check if this is a section heading. */
      const sectionLabel = normalizeR2SectionLabel(text);
      if (sectionLabel != null) {
        /* Flush the previous section. */
        flushSection();
        currentSection = sectionLabel;
        currentPages = [rp.page];
        currentPrintedPages = rp.printedPage != null ? [rp.printedPage] : [];
        continue;
      }

      /* Skip likely headings that don't parse (malformed). */
      if (isLikelySectionHeading(text) && currentSection == null) {
        /* Unlabeled text before any section heading — skip to avoid
         * cross-section bleed. */
        continue;
      }

      /* Content block: add to current section. */
      if (currentSection != null) {
        currentLines.push(text);
        currentRawLines.push(block.text);
        if (!currentPages.includes(rp.page)) {
          currentPages.push(rp.page);
        }
        if (rp.printedPage != null && !currentPrintedPages.includes(rp.printedPage)) {
          currentPrintedPages.push(rp.printedPage);
        }
      }
      /* Text before any section heading is not captured — it may be
       * PE header material, appropriation info, or unlabeled content
       * that we cannot reliably attribute. */
    }
  }

  /* Flush the last section. */
  flushSection();

  /* Completeness: if no mission/description section was found, emit an omission. */
  const hasMission = sections.some(
    (s) => s.narrativeType === 'mission' || s.narrativeType === 'description',
  );
  if (!hasMission && resolvedPages.length > 0) {
    omissions.push({
      peCode,
      page: resolvedPages[0]!.page,
      reason: 'missing_mission_or_description',
      rawText: `No mission or description section found for PE ${peCode} across ${resolvedPages.length} pages`,
    });
  }

  return { sections, omissions };
}
