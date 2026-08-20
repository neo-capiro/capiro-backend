/**
 * Segmentation + parse-mode selection for DoD budget PDFs.
 *
 * Two responsibilities, both PURE (operate on already-extracted per-page text stats so
 * they are deterministic and unit-testable — the PDF byte reading lives in the caller):
 *
 *  1. Parse-mode selection. Budget books are ALWAYS parsed from PDF (Neo's rule); this
 *     only decides WHICH LlamaParse PDF mode:
 *       - low embedded-text coverage  -> pdf_ocr     (scanned / image-only pages)
 *       - dense tables / many exhibits -> pdf_premium (best table fidelity)
 *       - otherwise                    -> pdf_fast
 *     This is a cost/quality optimization UNDER the PDF rule, never a switch to TXT.
 *
 *  2. Exhibit segmentation. Splits on repeated exhibit headers (R-2/R-2A/P-40/OP-5 ...)
 *     with neighbouring-page context, NOT arbitrary token counts, so a segment is a whole
 *     exhibit. Page ranges feed LlamaParse target_pages for large books.
 */

export interface PageTextStat {
  /** 1-based printed/sequential page index. */
  page: number;
  /** Characters of embedded (selectable) text pdf/pdfplumber found on the page. */
  textChars: number;
  /** Raw page text (may be empty for scanned pages). Used for header detection. */
  text: string;
}

export type ParseMode = 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';

export interface ModeDecision {
  mode: ParseMode;
  reason: string;
  /** Fraction of pages with a usable embedded-text layer (0..1). */
  textCoverage: number;
  scannedPages: number[];
}

const MIN_CHARS_FOR_TEXT_PAGE = 80;

/** Decide the LlamaParse PDF mode from per-page embedded-text coverage + table density. */
export function selectParseMode(pages: PageTextStat[], opts?: { exhibitHeaderCount?: number }): ModeDecision {
  if (pages.length === 0) {
    return { mode: 'pdf_fast', reason: 'no pages sampled', textCoverage: 0, scannedPages: [] };
  }
  const scannedPages = pages.filter((p) => p.textChars < MIN_CHARS_FOR_TEXT_PAGE).map((p) => p.page);
  const textCoverage = (pages.length - scannedPages.length) / pages.length;

  // Any meaningful block of pages without a text layer => OCR.
  if (textCoverage < 0.6) {
    return {
      mode: 'pdf_ocr',
      reason: `embedded-text coverage ${(textCoverage * 100).toFixed(0)}% < 60% (scanned pages present)`,
      textCoverage,
      scannedPages,
    };
  }

  // Dense exhibit books (many R-2A/P-40 tables) benefit from premium table extraction.
  const exhibitHeaders = opts?.exhibitHeaderCount ?? countExhibitHeaders(pages);
  if (exhibitHeaders >= 8) {
    return {
      mode: 'pdf_premium',
      reason: `${exhibitHeaders} exhibit headers detected (dense tables -> premium fidelity)`,
      textCoverage,
      scannedPages,
    };
  }

  return { mode: 'pdf_fast', reason: 'clean text layer, moderate table density', textCoverage, scannedPages };
}

/**
 * Exhibit header patterns. Anchored to the start of a line to avoid matching narrative
 * prose that merely mentions "R-2". Order matters: most specific first (R-2A before R-2).
 */
const EXHIBIT_PATTERNS: Array<{ type: string; re: RegExp }> = [
  { type: 'R-2A', re: /^\s*Exhibit\s+R-2A\b/im },
  { type: 'R-2', re: /^\s*Exhibit\s+R-2\b/im },
  { type: 'R-3', re: /^\s*Exhibit\s+R-3\b/im },
  { type: 'R-4', re: /^\s*Exhibit\s+R-4\b/im },
  { type: 'P-40', re: /^\s*Exhibit\s+P-40\b/im },
  { type: 'P-5', re: /^\s*Exhibit\s+P-5\b/im },
  { type: 'P-1', re: /^\s*Exhibit\s+P-1\b/im },
  { type: 'OP-5', re: /^\s*Exhibit\s+OP-5\b/im },
];

function detectHeader(text: string): string | null {
  for (const { type, re } of EXHIBIT_PATTERNS) {
    if (re.test(text)) return type;
  }
  return null;
}

export function countExhibitHeaders(pages: PageTextStat[]): number {
  return pages.reduce((n, p) => (detectHeader(p.text) ? n + 1 : n), 0);
}

export interface ExhibitSegment {
  exhibitType: string;
  pageStart: number;
  pageEnd: number;
  /** 0-based page indices for LlamaParse target_pages. */
  targetPages: number[];
}

/**
 * Split into exhibit-bounded segments. Each segment runs from an exhibit header page to
 * the page before the next header. Includes one page of leading context (the header page
 * itself). Pages before the first header are attached to the first segment so nothing is
 * dropped.
 */
export function segmentExhibits(pages: PageTextStat[]): ExhibitSegment[] {
  const sorted = [...pages].sort((a, b) => a.page - b.page);
  const boundaries: Array<{ page: number; type: string }> = [];
  for (const p of sorted) {
    const type = detectHeader(p.text);
    if (type) boundaries.push({ page: p.page, type });
  }
  if (boundaries.length === 0) {
    // No exhibit headers — treat the whole doc as one segment.
    const first = sorted[0]!.page;
    const last = sorted[sorted.length - 1]!.page;
    return [
      {
        exhibitType: 'document',
        pageStart: first,
        pageEnd: last,
        targetPages: sorted.map((p) => p.page - 1),
      },
    ];
  }

  const segments: ExhibitSegment[] = [];
  const firstPage = sorted[0]!.page;
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!;
    const start = i === 0 ? firstPage : b.page; // roll leading pages into the first segment
    const end = i + 1 < boundaries.length ? boundaries[i + 1]!.page - 1 : sorted[sorted.length - 1]!.page;
    const target: number[] = [];
    for (let pg = start; pg <= end; pg++) target.push(pg - 1);
    segments.push({ exhibitType: b.type, pageStart: start, pageEnd: end, targetPages: target });
  }
  return segments;
}
