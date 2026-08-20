/**
 * r2a-project-section-extractor — extract narrative sections (mission,
 * description, accomplishments, plans) from R-2A page blocks.
 *
 * Pure module. Consumes Phase 3 normalized page results; never invokes a
 * parser, never writes to a database, never calls LlamaParse.
 *
 * Source-faithful cleaning constraints (aligned with Workstream F):
 *   - preserve original text order and whitespace-normalized content;
 *   - do not summarize, paraphrase, or invent content;
 *   - section headers are matched case-insensitively and stripped from the
 *     extracted narrative text;
 *   - empty sections are omitted, not returned as empty strings.
 */
import type {
  LayoutBlockV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';

/* ------------------------------------------------------------------ */
/* Section vocabulary                                                  */
/* ------------------------------------------------------------------ */

export const R2A_PROJECT_SECTION_KIND_V1_VALUES = [
  'mission',
  'description',
  'accomplishments',
  'plans',
  'other',
] as const;
export type R2aProjectSectionKindV1 = (typeof R2A_PROJECT_SECTION_KIND_V1_VALUES)[number];

export interface R2aProjectSection {
  kind: R2aProjectSectionKindV1;
  /** Physical PDF page where the section starts. */
  page: number;
  printedPage?: string;
  /** Normalized narrative text (whitespace collapsed, headers stripped). */
  text: string;
  /** Source block indices that contributed to this section. */
  blockIndices: number[];
}

/* ------------------------------------------------------------------ */
/* Section header detection                                            */
/* ------------------------------------------------------------------ */

const SECTION_HEADER_PATTERNS: Array<{
  kind: R2aProjectSectionKindV1;
  pattern: RegExp;
}> = [
  { kind: 'mission', pattern: /^\s*mission\s*[:.\-]?\s*/i },
  { kind: 'description', pattern: /^\s*description\s*[:.\-]?\s*/i },
  { kind: 'accomplishments', pattern: /^\s*accomplishments?\s*[:.\-]?\s*/i },
  { kind: 'plans', pattern: /^\s*plans?\s*[:.\-]?\s*/i },
  { kind: 'other', pattern: /^\s*remarks?\s*[:.\-]?\s*/i },
  { kind: 'other', pattern: /^\s*notes?\s*[:.\-]?\s*/i },
];

const PROJECT_CODE_RE = /^[A-Z0-9][A-Z0-9.\-]*$/i;
const PE_CODE_RE = /^[0-9]{7}[A-Z][A-Z0-9]*$/;

/**
 * Detect whether a block looks like a section header for R-2A narrative
 * content. Headers are short blocks (usually headings or single-line text)
 * that match known section labels.
 */
function detectSectionHeader(block: LayoutBlockV1): R2aProjectSectionKindV1 | null {
  const text = block.text.trim();
  if (text.length === 0) return null;

  /* Skip blocks that look like project headers or PE references — those are
   * identity lines, not narrative section headers. */
  if (PE_CODE_RE.test(text)) return null;
  if (/^\s*PE\s+\d{7}[A-Z]/i.test(text)) return null;
  if (/^\s*R-2A\s/i.test(text)) return null;
  if (/^\s*RDT&E\s+Project\s+Justification/i.test(text)) return null;
  if (/^\s*project\s+code\s*[:.\-]?\s*/i.test(text)) return null;
  if (/^\s*project\s+title\s*[:.\-]?\s*/i.test(text)) return null;
  if (/^\s*budget\s+activity\s*[:.\-]?\s*/i.test(text)) return null;

  for (const { kind, pattern } of SECTION_HEADER_PATTERNS) {
    if (pattern.test(text)) return kind;
  }

  /* A heading block with no colon but exactly matching a known label. */
  const upper = text.toUpperCase();
  if (block.blockType === 'heading') {
    if (upper === 'MISSION') return 'mission';
    if (upper === 'DESCRIPTION') return 'description';
    if (upper === 'ACCOMPLISHMENTS' || upper === 'ACCOMPLISHMENT') return 'accomplishments';
    if (upper === 'PLANS' || upper === 'PLAN') return 'plans';
  }

  return null;
}

/**
 * Strip the section header label from the start of a block's text, leaving
 * the narrative content. Returns empty string when the block is only a header.
 */
function stripSectionHeader(block: LayoutBlockV1, kind: R2aProjectSectionKindV1): string {
  const text = block.text.trim();
  for (const { kind: k, pattern } of SECTION_HEADER_PATTERNS) {
    if (k === kind && pattern.test(text)) {
      return text.replace(pattern, '').trim();
    }
  }
  /* For heading blocks that matched exactly, nothing remains. */
  return '';
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Extract narrative sections from one R-2A page.
 *
 * Blocks are scanned in reading order. A section starts when a header is
 * detected; subsequent non-header blocks are appended until the next header
 * or end of page. Blocks that do not belong to any detected section are
 * ignored (they may be identity lines, footers, or unrelated text).
 */
export function extractR2aProjectSectionsFromPage(page: ParserPageResultV1): R2aProjectSection[] {
  const sections: R2aProjectSection[] = [];
  const blocks = [...page.blocks].sort((a, b) => (a.readingOrder ?? 0) - (b.readingOrder ?? 0));

  let currentKind: R2aProjectSectionKindV1 | null = null;
  let currentTextParts: string[] = [];
  let currentBlockIndices: number[] = [];
  let currentStartPage = page.page;
  let currentPrintedPage: string | undefined;

  const flush = (): void => {
    if (currentKind == null) return;
    const text = normalizeWhitespace(currentTextParts.join(' '));
    if (text.length > 0) {
      sections.push({
        kind: currentKind,
        page: currentStartPage,
        ...(currentPrintedPage != null ? { printedPage: currentPrintedPage } : {}),
        text,
        blockIndices: [...currentBlockIndices],
      });
    }
    currentKind = null;
    currentTextParts = [];
    currentBlockIndices = [];
  };

  for (const block of blocks) {
    const headerKind = detectSectionHeader(block);

    if (headerKind != null) {
      flush();
      currentKind = headerKind;
      currentStartPage = page.page;
      currentPrintedPage = page.printedPage;
      const remainder = stripSectionHeader(block, headerKind);
      if (remainder.length > 0) {
        currentTextParts.push(remainder);
        currentBlockIndices.push(block.blockIndex);
      }
      continue;
    }

    if (currentKind != null) {
      /* Skip blocks that are clearly not narrative content (page footers,
       * repeated exhibit headers, etc.). */
      const text = block.text.trim();
      if (text.length === 0) continue;
      if (isLikelyNonNarrativeBlock(block)) continue;
      currentTextParts.push(text);
      currentBlockIndices.push(block.blockIndex);
    }
  }

  flush();
  return sections;
}

/**
 * Merge sections across multiple pages for the same project. Sections of
 * the same kind are concatenated in page order; block evidence is preserved.
 */
export function mergeR2aProjectSections(pages: readonly ParserPageResultV1[]): R2aProjectSection[] {
  const byKind = new Map<R2aProjectSectionKindV1, R2aProjectSection>();

  for (const page of pages) {
    const sections = extractR2aProjectSectionsFromPage(page);
    for (const section of sections) {
      const existing = byKind.get(section.kind);
      if (existing == null) {
        byKind.set(section.kind, { ...section });
      } else {
        existing.text = normalizeWhitespace(`${existing.text} ${section.text}`);
        existing.blockIndices.push(...section.blockIndices);
      }
    }
  }

  /* Return in stable kind order. */
  const order: R2aProjectSectionKindV1[] = [
    'mission',
    'description',
    'accomplishments',
    'plans',
    'other',
  ];
  const result: R2aProjectSection[] = [];
  for (const kind of order) {
    const section = byKind.get(kind);
    if (section != null) result.push(section);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function isLikelyNonNarrativeBlock(block: LayoutBlockV1): boolean {
  const text = block.text.trim();
  /* Footers and headers that repeat exhibit metadata. */
  if (block.blockType === 'footer') return true;
  if (/^\s*R-2A\s*$/i.test(text)) return true;
  if (/^\s*R-2A\s/i.test(text)) return true;
  if (/^\s*RDT&E\s+Project\s+Justification/i.test(text)) return true;
  if (/^\s*PE\s+\d{7}[A-Z]/i.test(text)) return true;
  if (/^\s*project\s+code\s*[:.\-]?\s*/i.test(text)) return true;
  if (/^\s*project\s+title\s*[:.\-]?\s*/i.test(text)) return true;
  if (/^\s*budget\s+activity\s*[:.\-]?\s*/i.test(text)) return true;
  if (/^\s*page\s+\d+/i.test(text)) return true;
  if (/^\s*\d+\s*$/.test(text)) return true; // bare page number
  return false;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ */
/* Project-code policy                                                 */
/* ------------------------------------------------------------------ */

/**
 * Bounded nonblank source-token policy for project codes.
 *
 * Rules:
 *   - nonblank after trimming;
 *   - bounded length (1..32 characters) to prevent runaway tokens;
 *   - characters restricted to letters, digits, dots, and dashes;
 *   - must start with a letter or digit;
 *   - no whitespace allowed.
 *
 * This intentionally does NOT enforce a fixed width (e.g. exactly 3 chars)
 * because DoD project codes vary by component and era. Width expansion is
 * handled only through Workstream M's reviewed migration; we never truncate.
 */
export function isValidR2aProjectCode(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.length > 32) return false;
  if (!PROJECT_CODE_RE.test(trimmed)) return false;
  return true;
}
