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
 *     unresolved segments for review;
 *   - Document-level front matter (cover, blanks, tables of contents,
 *     appropriation-language boilerplate, roman-numeral-paginated index
 *     sections) becomes `non_semantic` segments and is silently excluded
 *     from R-2 identity completeness (Phase 10B-21) -- but ONLY when the
 *     page has no resolved R-2/R-2A/R-3/R-4 exhibit signal at all
 *     (structured OR body-text fallback); a page that resolves to a real
 *     exhibit is never reclassified merely because it also happens to
 *     mention a front-matter-shaped phrase.
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
  | 'r1_summary'
  | 'non_semantic'
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

/* Phase 10B-21 Part C: deterministic front-matter signals. These identify
 * document-level (not PE-level) pages by standardized DoD budget-exhibit
 * structural conventions -- never by fiscal year or physical page number:
 *   - a volume cover page names the "Justification Book" itself;
 *   - "Table of Contents" (bare, or the "Program Element Table of Contents"
 *     variant) is standard front-matter boilerplate in every R-2 volume;
 *   - "APPROPRIATION LANGUAGE" is the standardized legally-mandated section
 *     heading that opens every R-2 volume, verbatim, every fiscal year;
 *   - front-matter pages in this document family are paginated with lower-
 *     case roman numerals ("Volume 1a - vii"); PE content pages are always
 *     paginated with Arabic numerals ("Volume 1a - 43"). This is a generic
 *     print convention, not specific to any one volume or year, and is the
 *     strongest signal here because it still holds even when a front-matter
 *     page's OWN body text also happens to mention PE codes (e.g. a
 *     "Program Element/Project Restructures" administrative table). */
const COVER_PAGE_RE = /\bJustification Book\b/i;
const DOC_TOC_RE = /\bTable of Contents\b/i;
const APPROPRIATION_LANGUAGE_RE = /\bAPPROPRIATION LANGUAGE\b/i;
/* Phase 10B-23A Part E: Exhibit R-1 ("Total Obligational Authority") is DoD's
 * standardized document-wide appropriations-summary table -- distinct from
 * R-2/R-2A/R-3/R-4 (all PE-scoped) and from the generic front-matter caught
 * by the roman-numeral-footer rule below (blank separators, tables of
 * contents, restructure indexes). It is real, substantive government budget
 * data (line numbers, PE numbers, dollar figures for the WHOLE portfolio),
 * not "non-semantic" -- but it is also not a single-PE R-2 exhibit this
 * pipeline projects funding from. Detected the same way every other exhibit
 * type is: a durable, standardized exhibit title, never a fiscal year or
 * physical page number. Confirmed against the real FY2024 Army R-2 Volume 1
 * BA1 document (physical pages 11-37, scanned, "Exhibit R-1 FY 2024
 * President's Budget / Total Obligational Authority" on every page). */
const R1_SUMMARY_HEADER_RE = /\bExhibit R-1\b/i;
/* A well-formed roman numeral (1-3999), not merely a run of letters drawn
 * from {i,v,x,l,c,d,m} -- the looser form also matches ordinary English
 * words spelled entirely from that letter set ("civil", "mix", "dim").
 * Anchored to the end of the (trimmed) text, optionally followed only by a
 * trailing period/whitespace: this is a pagination footer convention, not a
 * volume cross-reference that can appear mid-sentence anywhere on a real
 * content page. */
const ROMAN_NUMERAL_FOOTER_RE =
  /\bVolume\s+\S+\s*[-–]\s*(?=[ivxlcdm])M{0,4}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})\s*\.?\s*$/i;

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

      case 'non_semantic': {
        /* Phase 10B-21 Part E: front matter still gets its own segment so
         * every physical page is accounted for in pageCoverage -- it is
         * simply never treated as R-2 identity/funding evidence. */
        startSegment('non_semantic', cls, {
          contextEvidence: [`non-semantic page: ${cls.reason}`],
        });
        break;
      }

      case 'r1_summary': {
        /* Phase 10B-23A Part E: distinct from 'non_semantic' -- this page
         * carries real government budget data (Exhibit R-1 document-wide
         * summary), just not data this R-2 pipeline projects. Gets its own
         * segment so pageCoverage still accounts for it and the semantic
         * artifact factory can preserve it as an explicit, non-blocking,
         * non-R-2-identity acknowledgment rather than silently dropping it. */
        startSegment('r1_summary', cls, {
          contextEvidence: [`R-1 summary page: ${cls.reason}`],
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
  const bodyOnlyText = bodyTexts.join(' ');
  const allText = [page.text ?? '', bodyOnlyText, allHeaderFooter].join(' ');

  /* Phase 10B-16 Part D: structured evidence (header/footer/heading) is
   * tried FIRST and is sufficient for most pages. Real R-2 exhibit pages,
   * however, can carry their PE code, exhibit title, and appropriation/BA
   * context entirely inside ordinary body-text blocks when nothing on the
   * page is structurally header/footer/heading-shaped -- `allText` used to
   * be computed here and never read, so that content was invisible to every
   * check below. Body text is now consulted, but ONLY as a fallback when
   * structured evidence found no exhibit-type signal at all, so a page that
   * already resolves from header/heading evidence is never altered by
   * scanning body text, and the four exhibit types never get a mismatched
   * per-type fallback (e.g. one type's body match contradicting another
   * type's structured match). */
  const structuredExhibitText = [allHeaderFooter, headingTexts.join(' ')].join(' ');
  const structuredIsR2 = R2_HEADER_RE.test(structuredExhibitText);
  const structuredIsR2A = R2A_HEADER_RE.test(structuredExhibitText);
  const structuredIsR3 = R3_HEADER_RE.test(structuredExhibitText);
  const structuredIsR4 = R4_HEADER_RE.test(structuredExhibitText);
  const hasStructuredExhibitSignal =
    structuredIsR2 || structuredIsR2A || structuredIsR3 || structuredIsR4;

  const isR2 = hasStructuredExhibitSignal ? structuredIsR2 : R2_HEADER_RE.test(bodyOnlyText);
  const isR2A = hasStructuredExhibitSignal ? structuredIsR2A : R2A_HEADER_RE.test(bodyOnlyText);
  const isR3 = hasStructuredExhibitSignal ? structuredIsR3 : R3_HEADER_RE.test(bodyOnlyText);
  const isR4 = hasStructuredExhibitSignal ? structuredIsR4 : R4_HEADER_RE.test(bodyOnlyText);

  /* Extract PE/project codes from header/footer AND heading blocks first;
   * fall back to body text using the same "structured evidence found
   * nothing" gate as the exhibit-type detection above. */
  const structuredPeCodes = [
    ...new Set([...extractPeCodes(allHeaderFooter), ...extractPeCodes(headingTexts.join(' '))]),
  ];
  const allPeCodes = hasStructuredExhibitSignal
    ? structuredPeCodes
    : [...new Set([...structuredPeCodes, ...extractPeCodes(bodyOnlyText)])];

  const structuredProjectCodes = [
    ...new Set([
      ...extractProjectCodes(allHeaderFooter),
      ...extractProjectCodes(headingTexts.join(' ')),
    ]),
  ];
  const allProjectCodes = hasStructuredExhibitSignal
    ? structuredProjectCodes
    : [...new Set([...structuredProjectCodes, ...extractProjectCodes(bodyOnlyText)])];

  /* Conflicting headers: multiple distinct PE codes in header/footer/heading. */
  const uniquePeCodes = [...new Set(allPeCodes)];
  const hasConflict = uniquePeCodes.length > 1;

  /* Detect explicit continuation markers, using the same structured-first,
   * body-fallback-only-when-structured-is-silent gate as above. */
  const structuredHasContinuationMarker = CONTINUATION_RE.test(structuredExhibitText);
  const hasContinuationMarker = hasStructuredExhibitSignal
    ? structuredHasContinuationMarker
    : structuredHasContinuationMarker || CONTINUATION_RE.test(bodyOnlyText);

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

  /* Phase 10B-21 Part B/C: document-level front matter (cover, blank
   * separators, tables of contents, appropriation-language boilerplate, and
   * roman-numeral-paginated index sections) is classified BEFORE the R-2
   * exhibit-type checks below, using only deterministic structural/textual
   * evidence -- never a page number or fiscal year. A page must be PROVEN
   * non-semantic by one of these signals; anything that doesn't match falls
   * through to the existing R-2/R-2A/R-3/R-4/unresolved logic unchanged, so
   * genuinely ambiguous pages still surface as 'unresolved' (Class 5) rather
   * than being silently classified away. */
  const trimmedAllText = allText.trim();
  /* Independent review finding (Phase 10B-21A): gating on
   * `hasStructuredExhibitSignal` alone is NOT sufficient. `isR2`/`isR2A`/
   * `isR3`/`isR4` above already have their own body-text fallback for
   * exactly the case where nothing on the page is structurally header/
   * footer/heading-shaped (Phase 10B-16 Part D) -- a real R-2 page resolved
   * ONLY through that fallback has `hasStructuredExhibitSignal === false`
   * but `isR2 === true`, and would have been wrongly available for
   * front-matter reclassification. The correct guard is the FULLY resolved
   * exhibit signal (structured OR body-fallback), not just the structured
   * half of it. */
  /* A page whose ONLY route to isR2/isR2A/isR3/isR4 is a body-text mention
   * of exhibit terminology while ALSO carrying multiple conflicting PE
   * codes (e.g. an introduction section explaining "R-2 (Army RDT&E Budget
   * Item Justification...), R-2A (...)" ahead of a PE-restructuring index
   * table) is not a real single-PE exhibit page -- the switch statement
   * below would itself route it to 'unresolved' via `hasConflict` regardless
   * of isR2/isR2A/isR3/isR4, so the BODY-FALLBACK half of the signal must
   * not count as a competing exhibit signal in that case.
   *
   * That conflict veto must NOT apply to a genuinely STRUCTURED header,
   * though: a page with a real header/heading block that happens to also
   * carry a second PE code (e.g. a cross-reference or restructuring note on
   * an otherwise real exhibit page) is exactly the ambiguous, structured
   * case the module's own `hasConflict` -> 'unresolved' branch exists to
   * surface for human review -- it must stay visible/blocking, never be
   * silently swept into non_semantic just because its body text also
   * happens to match a front-matter phrase. `hasStructuredExhibitSignal`
   * therefore protects unconditionally, matching the pre-Phase-10B-21
   * behavior for structured pages exactly; only the body-fallback path is
   * conflict-gated. */
  const hasAnyExhibitSignal =
    hasStructuredExhibitSignal || (!hasConflict && (isR2 || isR2A || isR3 || isR4));
  /* Guard every front-matter signal, including blank-page detection, on the
   * ABSENCE of any resolved R-2/R-2A/R-3/R-4 exhibit signal: a genuine PE
   * page whose narrative body incidentally mentions "the Table of Contents"
   * or a volume/roman-numeral cross-reference must never be reclassified
   * away from its real exhibit type merely because that phrase appears
   * somewhere on the page. Only a page with NO exhibit signal at all --
   * structured or body-fallback -- can be proven non-semantic this way.
   * Blank-page detection is gated too and kept to EXACT emptiness (not a
   * small-but-nonzero threshold): a page with a tiny residual text fragment
   * is evidence of an extraction FAILURE on real content, not proof the
   * page is genuinely blank, and must still surface as `unresolved`
   * (blocking, for review) rather than being silently skipped. */
  const isBlankPage = !hasAnyExhibitSignal && trimmedAllText.length === 0;
  const isCoverPage = !hasAnyExhibitSignal && COVER_PAGE_RE.test(allText);
  const isDocLevelToc = !hasAnyExhibitSignal && DOC_TOC_RE.test(allText);
  const isAppropriationLanguage = !hasAnyExhibitSignal && APPROPRIATION_LANGUAGE_RE.test(allText);
  /* Checked BEFORE the generic roman-numeral-front-matter rule: real Exhibit
   * R-1 summary pages are ALSO roman-numeral-paginated (they are document-
   * wide front matter, same print convention), so without this ordering they
   * would be swallowed by the generic rule and lose the distinction Part E
   * requires -- substantive government budget data, not "non-semantic". */
  const isR1Summary = !hasAnyExhibitSignal && R1_SUMMARY_HEADER_RE.test(allText);
  const isRomanNumeralFrontMatter =
    !hasAnyExhibitSignal && ROMAN_NUMERAL_FOOTER_RE.test(allText);

  if (isBlankPage) {
    kind = 'non_semantic';
    reason = 'blank page, no extractable content';
  } else if (isCoverPage) {
    kind = 'non_semantic';
    reason = 'volume cover/title page';
  } else if (isDocLevelToc) {
    kind = 'non_semantic';
    reason = 'document- or program-element-level table of contents';
  } else if (isAppropriationLanguage) {
    kind = 'non_semantic';
    reason = 'appropriation language boilerplate section';
  } else if (isR1Summary) {
    kind = 'r1_summary';
    reason = 'Exhibit R-1 (Total Obligational Authority) document-wide summary table';
  } else if (isRomanNumeralFrontMatter) {
    kind = 'non_semantic';
    reason = 'roman-numeral-paginated front matter (introduction/restructures/index)';
  } else if (hasConflict) {
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
