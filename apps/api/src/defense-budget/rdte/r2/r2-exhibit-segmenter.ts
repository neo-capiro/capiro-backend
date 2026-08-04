/**
 * r2-exhibit-segmenter — classify RDT&E volume pages into R-2/R-2A/R-3/R-4
 * exhibit segments.
 *
 * Pure module. Consumes parser outputs; never invokes a parser.
 *
 * Classification is deterministic and boundary-aware:
 *   - R-2 PE summary pages start a new PE segment;
 *   - R-2 continuation pages extend the current PE segment only when
 *     deterministic adjacent-page evidence supports it;
 *   - R-2A project pages start a new project segment under the current PE;
 *   - R-3/R-4 pages are their own segments and never consumed as R-2 narrative;
 *   - Pages with conflicting headers or no resolvable context become
 *     unresolved segments for review.
 */
import type {
  LayoutBlockV1,
  ParserPageResultV1,
} from '../../parser-router/parser-runtime-contract-v1.js';
import { isValidPeCode } from '../../extractors/types.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type R2PageKind =
  | 'r2_pe_summary'
  | 'r2_continuation'
  | 'r2a_project'
  | 'r3_page'
  | 'r4_page'
  | 'unresolved';

export interface R2PageClassification {
  page: number;
  printedPage?: string;
  kind: R2PageKind;
  /** Raw header/footer text blocks found on this page. */
  headerTexts: string[];
  footerTexts: string[];
  /** PE codes detected in header/footer text (may be multiple). */
  headerPeCodes: string[];
  /** Project codes detected in header/footer text. */
  headerProjectCodes: string[];
  /** Deterministic evidence that this page continues the prior segment. */
  continuationEvidence: string[];
  /** Human-readable reason for classification. */
  reason: string;
}

export interface R2Segment {
  segmentId: string;
  kind: R2PageKind;
  /** Physical PDF pages in this segment, sorted ascending. */
  pages: number[];
  printedPages: string[];
  /** Resolved PE context (undefined for unresolved segments). */
  peCode?: string;
  /** Resolved project context (undefined for PE-level or unresolved segments). */
  projectCode?: string;
  /** Appropriation / budget activity when detectable from header text. */
  appropriation?: string;
  budgetActivity?: string;
  /** Evidence strings used to resolve context. */
  contextEvidence: string[];
  /** For unresolved segments: why resolution failed. */
  unresolvedReason?: string;
  /** Per-page context source within this segment. */
  pageContextSources: Map<number, 'explicit_header' | 'deterministic_continuation'>;
}

export interface R2SegmentationResult {
  classifications: R2PageClassification[];
  segments: R2Segment[];
  /** Every page appears in exactly one segment or one unresolved finding. */
  pageCoverage: Map<number, string>;
}

/* ------------------------------------------------------------------ */
/* Regexes                                                             */
/* ------------------------------------------------------------------ */

const PE_CODE_RE = /\b([0-9]{7}[A-Z][A-Z0-9]*)\b/g;
const PROJECT_CODE_RE = /\b(?:project|proj)\s*(?:code|number|#)?\s*[:\-]?\s*([A-Z0-9]{2,8})\b/gi;

/** Extract project codes from text, avoiding false positives from the word "project" itself. */
function extractProjectCodes(text: string): string[] {
  const codes: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PROJECT_CODE_RE.source, 'gi');
  while ((match = re.exec(text)) != null) {
    const code = match[1]!;
    /* Filter out common English words that happen to match the pattern. */
    if (!/^(ect|code|number|proj|project)$/i.test(code)) {
      codes.push(code);
    }
  }
  return codes;
}
const R2_HEADER_RE = /\bR-2\b|\bRDT&E\s+Budget\s+Item\s+Justification\b/i;
const R2A_HEADER_RE = /\bR-2A\b|\bRDT&E\s+Project\s+Justification\b/i;
const R3_HEADER_RE = /\bR-3\b|\bRDT&E\s+Cost\s+Analysis\b/i;
const R4_HEADER_RE = /\bR-4\b|\bR-4A\b|\bRDT&E\s+Schedule\s+Profile\b/i;
const APPROPRIATION_RE = /\b(?:appropriation|appn)\s*[:\-]?\s*([A-Z0-9\s&]+?)(?:\s{2,}|$)/i;
const BA_RE = /\b(?:budget\s*activity|ba)\s*[:\-]?\s*([A-Z0-9\s]+?)(?:\s{2,}|$)/i;
const CONTINUATION_RE = /\bcontinued\b|\bcontinuation\b|\bcont\.?\b/i;

/* ------------------------------------------------------------------ */
/* Segmenter                                                           */
/* ------------------------------------------------------------------ */

/**
 * Classify every page and build deterministic segments.
 *
 * Pages are processed in the order supplied; the caller is responsible for
 * sorting by physical page number if determinism is required.
 */
export function segmentR2ExhibitPages(pages: readonly ParserPageResultV1[]): R2SegmentationResult {
  const classifications: R2PageClassification[] = [];
  const segments: R2Segment[] = [];
  const pageCoverage = new Map<number, string>();

  /* ---------- Pass 1: classify each page independently ---------- */
  for (const page of pages) {
    classifications.push(classifyPage(page));
  }

  /* ---------- Pass 2: build segments with boundary rules ---------- */
  let currentSegment: R2Segment | null = null;
  let segmentCounter = 0;

  const closeCurrentSegment = (): void => {
    if (currentSegment != null) {
      segments.push(currentSegment);
      currentSegment = null;
    }
  };

  const startSegment = (
    kind: R2PageKind,
    classification: R2PageClassification,
    overrides?: Partial<R2Segment>,
  ): R2Segment => {
    closeCurrentSegment();
    segmentCounter += 1;
    const segment: R2Segment = {
      segmentId: `seg_${segmentCounter.toString().padStart(4, '0')}`,
      kind,
      pages: [classification.page],
      printedPages: classification.printedPage != null ? [classification.printedPage] : [],
      contextEvidence: [...classification.continuationEvidence],
      pageContextSources: new Map([[classification.page, 'explicit_header']]),
      ...overrides,
    };
    currentSegment = segment;
    pageCoverage.set(classification.page, segment.segmentId);
    return segment;
  };

  const extendSegment = (classification: R2PageClassification): void => {
    if (currentSegment == null) return;
    currentSegment.pages.push(classification.page);
    if (classification.printedPage != null) {
      currentSegment.printedPages.push(classification.printedPage);
    }
    currentSegment.contextEvidence.push(...classification.continuationEvidence);
    currentSegment.pageContextSources.set(classification.page, 'deterministic_continuation');
    pageCoverage.set(classification.page, currentSegment.segmentId);
  };

  const canInheritContinuation = (
    cls: R2PageClassification,
    prev: R2PageClassification | null,
  ): boolean => {
    if (currentSegment == null) return false;
    const segKind: R2PageKind = currentSegment.kind;
    if (segKind !== 'r2_pe_summary' && segKind !== 'r2_continuation') return false;
    if (prev == null) return false;
    if (prev.page !== cls.page - 1) return false;
    return cls.continuationEvidence.length > 0;
  };

  for (let i = 0; i < classifications.length; i++) {
    const cls = classifications[i]!;
    const prev: R2PageClassification | null = i > 0 ? (classifications[i - 1] ?? null) : null;

    switch (cls.kind) {
      case 'r2_pe_summary': {
        /* A new explicit PE header always ends the prior PE segment. */
        const peCode = cls.headerPeCodes[0];
        startSegment('r2_pe_summary', cls, {
          ...(peCode != null ? { peCode } : {}),
          contextEvidence: [`explicit PE header: ${cls.headerTexts.join(' | ')}`],
        });
        break;
      }

      case 'r2_continuation': {
        /* Continuation may inherit context only when deterministic
         * adjacent-page evidence supports it. */
        if (canInheritContinuation(cls, prev)) {
          extendSegment(cls);
        } else {
          startSegment('unresolved', cls, {
            unresolvedReason:
              cls.continuationEvidence.length === 0
                ? 'no deterministic continuation evidence'
                : 'no adjacent R-2 segment to continue',
          });
        }
        break;
      }

      case 'r2a_project': {
        /* R-2A must retain its explicit parent PE. */
        const peCode = cls.headerPeCodes[0];
        const projectCode = cls.headerProjectCodes[0];
        if (peCode == null) {
          startSegment('unresolved', cls, {
            unresolvedReason: 'R-2A page lacks explicit parent PE code',
          });
        } else {
          startSegment('r2a_project', cls, {
            peCode,
            ...(projectCode != null ? { projectCode } : {}),
            contextEvidence: [`explicit R-2A header: ${cls.headerTexts.join(' | ')}`],
          });
        }
        break;
      }

      case 'r3_page':
      case 'r4_page': {
        /* R-3/R-4 pages are never consumed as R-2 narrative. */
        startSegment(cls.kind, cls, {
          contextEvidence: [`exhibit header: ${cls.headerTexts.join(' | ')}`],
        });
        break;
      }

      case 'unresolved': {
        startSegment('unresolved', cls, {
          unresolvedReason: cls.reason,
        });
        break;
      }
    }
  }
  closeCurrentSegment();

  /* ---------- Pass 3: sort segments deterministically by first page ---------- */
  segments.sort((a, b) => a.pages[0]! - b.pages[0]!);

  /* Reassign segment IDs after sorting for determinism. */
  const sortedPageCoverage = new Map<number, string>();
  segments.forEach((segment, index) => {
    segment.segmentId = `seg_${(index + 1).toString().padStart(4, '0')}`;
    for (const page of segment.pages) {
      sortedPageCoverage.set(page, segment.segmentId);
    }
  });

  /* ---------- Pass 4: extract appropriation / BA from segment headers ---------- */
  for (const segment of segments) {
    if (segment.kind === 'r2_pe_summary' || segment.kind === 'r2a_project') {
      const headerText = segment.contextEvidence.join(' ');
      const appn = APPROPRIATION_RE.exec(headerText);
      if (appn != null) segment.appropriation = appn[1]!.trim();
      const ba = BA_RE.exec(headerText);
      if (ba != null) segment.budgetActivity = ba[1]!.trim();
    }
  }

  return { classifications, segments, pageCoverage: sortedPageCoverage };
}

/* ------------------------------------------------------------------ */
/* Page classification                                                 */
/* ------------------------------------------------------------------ */

function classifyPage(page: ParserPageResultV1): R2PageClassification {
  const headerTexts: string[] = [];
  const footerTexts: string[] = [];
  const bodyTexts: string[] = [];
  const headingTexts: string[] = [];

  for (const block of page.blocks) {
    const text = block.text.trim();
    if (text === '') continue;
    if (block.blockType === 'header') {
      headerTexts.push(text);
    } else if (block.blockType === 'footer') {
      footerTexts.push(text);
    } else if (block.blockType === 'heading') {
      headingTexts.push(text);
      bodyTexts.push(text);
    } else {
      bodyTexts.push(text);
    }
  }

  const allHeaderFooter = [...headerTexts, ...footerTexts].join(' ');
  const allText = [page.text ?? '', ...bodyTexts, allHeaderFooter].join(' ');

  /* Extract PE codes from header/footer AND heading blocks. In real R-2
   * pages the PE code often appears in a heading, not a running header. */
  const headerPeCodes = extractPeCodes(allHeaderFooter);
  const headingPeCodes = extractPeCodes(headingTexts.join(' '));
  const allPeCodes = [...new Set([...headerPeCodes, ...headingPeCodes])];

  const headerProjectCodes = extractProjectCodes(allHeaderFooter);
  const headingProjectCodes = extractProjectCodes(headingTexts.join(' '));
  const allProjectCodes = [...new Set([...headerProjectCodes, ...headingProjectCodes])];

  /* Detect exhibit type from header/footer/heading text. */
  const isR2 = R2_HEADER_RE.test(allHeaderFooter) || R2_HEADER_RE.test(headingTexts.join(' '));
  const isR2A = R2A_HEADER_RE.test(allHeaderFooter) || R2A_HEADER_RE.test(headingTexts.join(' '));
  const isR3 = R3_HEADER_RE.test(allHeaderFooter) || R3_HEADER_RE.test(headingTexts.join(' '));
  const isR4 = R4_HEADER_RE.test(allHeaderFooter) || R4_HEADER_RE.test(headingTexts.join(' '));

  /* Conflicting headers: multiple distinct PE codes in header/footer/heading. */
  const uniquePeCodes = [...new Set(allPeCodes)];
  const hasConflict = uniquePeCodes.length > 1;

  /* Detect explicit continuation markers. */
  const hasContinuationMarker =
    CONTINUATION_RE.test(allHeaderFooter) || CONTINUATION_RE.test(headingTexts.join(' '));

  /* Continuation evidence: repeated header/footer patterns that match the
   * prior page's segment, or explicit "continued" markers. A bare R-2 volume
   * header on its own is NOT continuation evidence — a page with no PE code
   * and no explicit continuation marker must become an unresolved finding
   * rather than silently merge into the adjacent PE segment. */
  const continuationEvidence: string[] = [];
  if (hasContinuationMarker) {
    continuationEvidence.push('explicit continuation marker');
  }
  if (allPeCodes.length > 0) {
    continuationEvidence.push(`repeated PE header: ${allPeCodes.join(', ')}`);
  }

  /* Determine kind. */
  let kind: R2PageKind;
  let reason: string;

  if (hasConflict) {
    kind = 'unresolved';
    reason = `conflicting PE headers: ${uniquePeCodes.join(', ')}`;
  } else if (isR3) {
    kind = 'r3_page';
    reason = 'R-3 exhibit header detected';
  } else if (isR4) {
    kind = 'r4_page';
    reason = 'R-4/R-4A exhibit header detected';
  } else if (isR2A) {
    kind = 'r2a_project';
    reason = 'R-2A project header detected';
  } else if (isR2 && allPeCodes.length > 0 && !hasContinuationMarker) {
    /* Explicit R-2 header with PE code and NO continuation marker = new PE. */
    kind = 'r2_pe_summary';
    reason = 'R-2 PE summary header with explicit PE code';
  } else if (isR2 && allPeCodes.length > 0 && hasContinuationMarker) {
    /* R-2 header with PE code AND continuation marker = continuation. */
    kind = 'r2_continuation';
    reason = 'R-2 continuation with repeated PE header';
  } else if (isR2 && allPeCodes.length === 0) {
    /* R-2 header without PE code = continuation candidate. */
    kind = 'r2_continuation';
    reason = 'R-2 header without PE code (continuation candidate)';
  } else if (allPeCodes.length > 0 && continuationEvidence.length > 0) {
    kind = 'r2_continuation';
    reason = 'repeated PE header suggests continuation';
  } else {
    kind = 'unresolved';
    reason = 'no exhibit header or PE context detected';
  }

  return {
    page: page.page,
    ...(page.printedPage != null ? { printedPage: page.printedPage } : {}),
    kind,
    headerTexts,
    footerTexts,
    headerPeCodes: allPeCodes,
    headerProjectCodes: allProjectCodes,
    continuationEvidence,
    reason,
  };
}

function extractPeCodes(text: string): string[] {
  const codes: string[] = [];
  let match: RegExpExecArray | null;
  const re = new RegExp(PE_CODE_RE.source, 'g');
  while ((match = re.exec(text)) != null) {
    const code = match[1]!;
    if (isValidPeCode(code)) {
      codes.push(code);
    }
  }
  return codes;
}
