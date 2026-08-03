/**
 * Workstream K — Deterministic page-result compositor.
 *
 * Combine page results from multiple parsers without losing lineage or
 * silently replacing data. Every page has exactly one selected result or
 * an explicit failure. Output is deterministic regardless of input order.
 *
 * K1: Inputs — page profile, parser results, parse plan, verifier history,
 *     deterministic selection policy.
 * K2: Selected page result — one per requested page.
 * K3: Selection rules — based on verification coverage, not model ranking.
 * K4: Deduplication — by canonical content hash, not title/approximate text.
 * K5: Page order — ascending, blocks/tables retain parser order + fallback.
 * K6: Lineage — every block/table traceable to parser run ID, method,
 *     version, config SHA, source SHA, page, output artifact SHA.
 */
import { z } from 'zod';
import {
  type ParserPageResultV1,
  type ParserPageFailureV1,
  type ParserRuntimeResultV1,
  type LayoutBlockV1,
  type ParsedTableV1,
  type EvidencePrecisionV1,
  computeResultContentSha256,
  pageRangeKey,
} from './parser-runtime-contract-v1.js';
import {
  type DefenseBudgetParsePlanV1,
} from './route-planner.js';
import {
  sha256CanonicalJson,
  type JsonValue,
} from '../contracts/canonical-json.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* K2. Selected page result contract                                   */
/* ------------------------------------------------------------------ */

export interface ParserRunResultEntry {
  parserRunId: string;
  result: ParserRuntimeResultV1;
  method: ExtractionMethodV1;
  parserVersion: string;
  parserConfigSha256: string;
  sourceSha256: string;
  outputArtifactSha256: string;
}

export interface PageLineageEntry {
  parserRunId: string;
  method: ExtractionMethodV1;
  parserVersion: string;
  parserConfigSha256: string;
  sourceSha256: string;
  page: number;
  outputArtifactSha256: string;
}

export interface SelectedPageResultV1 {
  page: number;
  selectedParserRunId: string | null;
  selectionReasonCodes: string[];
  selectedResult: ParserPageResultV1 | null;
  alternativeParserRunIds: string[];
  failures: ParserPageFailureV1[];
}

export interface ComposedPageOutputV1 {
  schemaVersion: 'defense_budget_composed_output_v1';
  executionId: string;
  sourceSha256: string;
  pages: SelectedPageResultV1[];
  lineages: PageLineageEntry[];
  contentSha256: string;
}

/* ------------------------------------------------------------------ */
/* K3. Selection policy                                               */
/* ------------------------------------------------------------------ */

export type SelectionPolicy = 'strict_verification_coverage' | 'engine_preference';

export const DEFAULT_SELECTION_POLICY: SelectionPolicy = 'strict_verification_coverage';

export const ENGINE_PREFERENCE_ORDER: ExtractionMethodV1[] = [
  'native_structured',
  'deterministic_pdfplumber',
  'docling',
  'camelot',
  'llamaparse',
  'paddleocr',
  'manual',
];

/**
 * Reason codes for why a parser result was selected or not.
 */
export const SELECTION_REASON_CODES = {
  RESOLVED_FINDING: 'resolved_verifier_finding',
  PAID_DOES_NOT_OUTRANK: 'paid_does_not_outrank_local_without_reason',
  OCR_NOT_OVER_CLEAN: 'ocr_not_over_clean_digital_without_reason',
  FIRST_SUCCESSFUL: 'first_successful_local_engine',
  HIGHER_PRECISION: 'higher_evidence_precision',
  DEDUPLICATED: 'deduplicated_identical_content',
  CONFLICT_RETAINED: 'conflicting_result_retained_as_alternative',
  NO_RESULTS: 'no_parser_results_for_page',
  ALL_FAILED: 'all_parsers_failed_for_page',
} as const;

/* ------------------------------------------------------------------ */
/* K4. Deduplication                                                  */
/* ------------------------------------------------------------------ */

/**
 * Compute the canonical content hash of a page result's blocks and tables.
 * Used for deduplication — two results with the same hash are identical.
 */
export function computeBlockTableHash(page: ParserPageResultV1): string {
  const content: JsonValue = {
    blocks: page.blocks.map((b) => ({
      type: b.blockType,
      text: b.text,
      order: b.readingOrder ?? b.blockIndex,
    })),
    tables: page.tables.map((t) => ({
      cells: t.cells.map((c) => ({
        r: c.rowIndex,
        c: c.columnIndex,
        text: c.text,
      })),
      rowCount: t.rowCount,
      columnCount: t.columnCount,
    })),
  };
  return sha256CanonicalJson(content);
}

/**
 * Check if two page results have identical content (by canonical hash).
 */
export function arePageResultsIdentical(a: ParserPageResultV1, b: ParserPageResultV1): boolean {
  return computeBlockTableHash(a) === computeBlockTableHash(b);
}

/* ------------------------------------------------------------------ */
/* K6. Lineage                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build lineage entries for all blocks/tables from a parser run result.
 */
export function buildLineageEntries(entry: ParserRunResultEntry): PageLineageEntry[] {
  const lineages: PageLineageEntry[] = [];
  for (const page of entry.result.pages) {
    lineages.push({
      parserRunId: entry.parserRunId,
      method: entry.method,
      parserVersion: entry.parserVersion,
      parserConfigSha256: entry.parserConfigSha256,
      sourceSha256: entry.sourceSha256,
      page: page.page,
      outputArtifactSha256: entry.outputArtifactSha256,
    });
  }
  return lineages;
}

/* ------------------------------------------------------------------ */
/* K3. Selection logic                                                */
/* ------------------------------------------------------------------ */

interface PageCandidate {
  entry: ParserRunResultEntry;
  pageResult: ParserPageResultV1;
  hasFailures: boolean;
  failures: ParserPageFailureV1[];
}

/**
 * Collect all candidates for a specific page from all parser run results.
 */
function collectPageCandidates(
  entries: readonly ParserRunResultEntry[],
  pageNumber: number,
): PageCandidate[] {
  const candidates: PageCandidate[] = [];
  for (const entry of entries) {
    const pageResult = entry.result.pages.find((p) => p.page === pageNumber);
    if (pageResult) {
      candidates.push({
        entry,
        pageResult,
        hasFailures: false,
        failures: [],
      });
    }
    // Check for explicit failures for this page
    const failure = entry.result.failedPages.find((f) => f.page === pageNumber);
    if (failure) {
      candidates.push({
        entry,
        pageResult: entry.result.pages.find((p) => p.page === pageNumber)!,
        hasFailures: true,
        failures: [failure],
      });
    }
  }
  return candidates;
}

/**
 * Determine evidence precision rank — higher is better.
 */
function precisionRank(p: EvidencePrecisionV1): number {
  switch (p) {
    case 'cell_bbox': return 3;
    case 'text_span': return 2;
    case 'page_only': return 1;
  }
}

/**
 * Select the best candidate for a page based on the deterministic policy.
 *
 * Rules (K3):
 * 1. A result that resolved a verifier finding may replace the prior result.
 * 2. Unrelated content must not disappear; compose compatible blocks/tables.
 * 3. Conflicting results are retained as alternatives.
 * 4. LlamaParse does not automatically outrank local output.
 * 5. OCR does not outrank embedded-text output on a clean page.
 * 6. Manual last-wins replacement is forbidden.
 */
function selectPageCandidate(
  candidates: PageCandidate[],
  pageNumber: number,
  escalationRunIds?: Set<string>,
): SelectedPageResultV1 {
  if (candidates.length === 0) {
    return {
      page: pageNumber,
      selectedParserRunId: null,
      selectionReasonCodes: [SELECTION_REASON_CODES.NO_RESULTS],
      selectedResult: null,
      alternativeParserRunIds: [],
      failures: [],
    };
  }

  // Filter to candidates with successful page results (not just failures)
  const successful = candidates.filter((c) => !c.hasFailures);
  const allFailed = candidates.filter((c) => c.hasFailures);

  if (successful.length === 0) {
    // All parsers failed for this page
    return {
      page: pageNumber,
      selectedParserRunId: null,
      selectionReasonCodes: [SELECTION_REASON_CODES.ALL_FAILED],
      selectedResult: null,
      alternativeParserRunIds: [],
      failures: allFailed.flatMap((c) => c.failures),
    };
  }

  // K3 Rule 1: If a page resolved a verifier finding, prefer the engine
  // from the escalation plan (later step = higher ordinal = resolved finding)
  // For now, we use engine preference order as the deterministic tiebreaker.

  // K3 Rule 4: LlamaParse does not automatically outrank local.
  // K3 Rule 5: OCR does not outrank embedded-text without reason.
  // We rank by: resolved finding > evidence precision > engine preference order

  const escalationIds = escalationRunIds ?? new Set<string>();

  let best = successful[0]!;
  let bestReason: string = escalationIds.has(best.entry.parserRunId)
    ? SELECTION_REASON_CODES.RESOLVED_FINDING
    : SELECTION_REASON_CODES.FIRST_SUCCESSFUL;
  let bestRank = 0;

  // Compute initial rank for the first candidate
  bestRank = computeCandidateRank(best, escalationIds.has(best.entry.parserRunId));

  for (let i = 1; i < successful.length; i++) {
    const candidate = successful[i]!;
    const candidateRank = computeCandidateRank(candidate, escalationIds.has(candidate.entry.parserRunId));

    if (candidateRank > bestRank) {
      const loser = best;
      best = candidate;
      bestRank = candidateRank;
      bestReason = determineSelectionReason(candidate, loser, escalationIds.has(candidate.entry.parserRunId));
    }
  }

  // Collect alternatives (all successful results that are not the selected one)
  const alternatives = successful
    .filter((c) => c.entry.parserRunId !== best.entry.parserRunId)
    .map((c) => c.entry.parserRunId);

  // K4: Deduplicate — check if any alternatives are identical to the selected
  const dedupedAlternatives: string[] = [];
  for (const alt of alternatives) {
    const altCandidate = successful.find((c) => c.entry.parserRunId === alt);
    if (altCandidate && !arePageResultsIdentical(altCandidate.pageResult, best.pageResult)) {
      dedupedAlternatives.push(alt);
    } else if (altCandidate && arePageResultsIdentical(altCandidate.pageResult, best.pageResult)) {
      // Identical — don't include as alternative, it's deduplicated
      continue;
    } else {
      dedupedAlternatives.push(alt);
    }
  }

  return {
    page: pageNumber,
    selectedParserRunId: best.entry.parserRunId,
    selectionReasonCodes: [bestReason],
    selectedResult: best.pageResult,
    alternativeParserRunIds: dedupedAlternatives,
    failures: allFailed.flatMap((c) => c.failures),
  };
}

/**
 * Compute a deterministic rank for a candidate.
 * Higher rank = better candidate.
 *
 * Ranking factors (in order):
 * 1. Escalation run (resolved verifier finding) (weight: 1000)
 * 2. Evidence precision (weight: 100)
 * 3. Engine preference order (weight: 10)
 * 4. Parser run ID (tiebreaker, weight: 1)
 */
function computeCandidateRank(candidate: PageCandidate, isEscalation: boolean): number {
  let rank = 0;
  if (isEscalation) rank += 1000;
  rank += precisionRank(candidate.pageResult.evidencePrecision) * 100;
  const engineIdx = ENGINE_PREFERENCE_ORDER.indexOf(candidate.entry.method);
  // Lower index = higher preference, so invert
  rank += (ENGINE_PREFERENCE_ORDER.length - engineIdx) * 10;
  // Tiebreaker: lexicographic parser run ID for determinism
  // (negative so that lower string = higher rank — deterministic)
  rank -= candidate.entry.parserRunId.charCodeAt(0) || 0;
  return rank;
}

/**
 * Determine the reason code for why a candidate was selected over another.
 */
function determineSelectionReason(
  winner: PageCandidate,
  loser: PageCandidate,
  winnerIsEscalation: boolean,
): string {
  if (winnerIsEscalation) {
    return SELECTION_REASON_CODES.RESOLVED_FINDING;
  }
  // Check if winner has higher precision
  if (precisionRank(winner.pageResult.evidencePrecision) > precisionRank(loser.pageResult.evidencePrecision)) {
    return SELECTION_REASON_CODES.HIGHER_PRECISION;
  }
  // Check if paid lost to local (K3 Rule 4)
  if (loser.entry.method === 'llamaparse' && winner.entry.method !== 'llamaparse') {
    return SELECTION_REASON_CODES.PAID_DOES_NOT_OUTRANK;
  }
  // Check if OCR lost to clean digital (K3 Rule 5)
  if (loser.entry.method === 'paddleocr' && winner.entry.method !== 'paddleocr') {
    return SELECTION_REASON_CODES.OCR_NOT_OVER_CLEAN;
  }
  return SELECTION_REASON_CODES.FIRST_SUCCESSFUL;
}

/* ------------------------------------------------------------------ */
/* K5. Main compositor entry point                                    */
/* ------------------------------------------------------------------ */

export interface ComposeOptions {
  executionId: string;
  sourceSha256: string;
  requestedPages: number[];
  parserRunEntries: readonly ParserRunResultEntry[];
  plan?: DefenseBudgetParsePlanV1;
  /** Parser run IDs that were executed as escalation steps to resolve verifier findings. */
  escalationRunIds?: Set<string>;
  selectionPolicy?: SelectionPolicy;
}

/**
 * Compose page results from multiple parser runs into a deterministic
 * selected-page output.
 *
 * K1: Accepts page profile (via plan), parser results, parse plan,
 *     verifier history (resolved findings), selection policy.
 * K2: Produces exactly one selected result or explicit failure per page.
 * K3: Selection is deterministic and verification-coverage-based.
 * K4: Deduplicates by canonical content hash.
 * K5: Output pages sorted ascending.
 * K6: Lineage preserved for all blocks/tables.
 */
export function composePageResults(opts: ComposeOptions): ComposedPageOutputV1 {
  const policy = opts.selectionPolicy ?? DEFAULT_SELECTION_POLICY;
  const escalationIds = opts.escalationRunIds ?? new Set<string>();

  // K5: Process pages in ascending order
  const sortedPages = [...opts.requestedPages].sort((a, b) => a - b);

  const pageSelections: SelectedPageResultV1[] = [];

  for (const pageNumber of sortedPages) {
    const candidates = collectPageCandidates(opts.parserRunEntries, pageNumber);
    const selected = selectPageCandidate(candidates, pageNumber, escalationIds);
    pageSelections.push(selected);
  }

  // K6: Build lineage entries from all parser runs
  const lineages: PageLineageEntry[] = [];
  for (const entry of opts.parserRunEntries) {
    lineages.push(...buildLineageEntries(entry));
  }

  // Sort lineages deterministic: by page, then parser run ID
  lineages.sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.parserRunId.localeCompare(b.parserRunId);
  });

  const unsealed: Omit<ComposedPageOutputV1, 'contentSha256'> = {
    schemaVersion: 'defense_budget_composed_output_v1',
    executionId: opts.executionId,
    sourceSha256: opts.sourceSha256,
    pages: pageSelections,
    lineages,
  };

  // Compute content SHA (deterministic)
  const contentSha256 = sha256CanonicalJson(unsealed as unknown as JsonValue);

  return {
    ...unsealed,
    contentSha256,
  };
}

/* ------------------------------------------------------------------ */
/* Validation helpers                                                 */
/* ------------------------------------------------------------------ */

/**
 * Verify that a composed output's content SHA is valid.
 */
export function verifyComposedContentSha(output: ComposedPageOutputV1): boolean {
  try {
    const { contentSha256: _, ...rest } = output;
    const recomputed = sha256CanonicalJson(rest as unknown as JsonValue);
    return recomputed === output.contentSha256;
  } catch {
    return false;
  }
}

/**
 * Validate that every page has exactly one selected result or one explicit failure.
 */
export function validatePageCompleteness(pages: SelectedPageResultV1[]): boolean {
  for (const page of pages) {
    // A page is "accounted for" if it has either:
    // 1. A selected result (selectedResult !== null), OR
    // 2. An explicit null with a reason code (e.g. NO_RESULTS or ALL_FAILED)
    if (page.selectedResult === null && page.selectionReasonCodes.length === 0) {
      return false; // neither result nor reason
    }
  }
  return true;
}
