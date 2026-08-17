/**
 * Deterministic page-result compositor.
 *
 * Every requested physical page receives exactly one selected parser result or
 * an explicit failure. Conflicting outputs remain visible as alternatives and
 * every parser contribution retains full lineage.
 */
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import type { DefenseBudgetParsePlanV1 } from './route-planner.js';
import type {
  EvidencePrecisionV1,
  ParserPageFailureV1,
  ParserPageResultV1,
  ParserRuntimeResultV1,
} from './parser-runtime-contract-v1.js';

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

export function computeBlockTableHash(page: ParserPageResultV1): string {
  const content: JsonValue = {
    blocks: page.blocks.map((block) => ({
      type: block.blockType,
      text: block.text,
      order: block.readingOrder ?? block.blockIndex,
    })),
    tables: page.tables.map((table) => ({
      cells: table.cells.map((cell) => ({
        r: cell.rowIndex,
        c: cell.columnIndex,
        text: cell.text,
      })),
      rowCount: table.rowCount,
      columnCount: table.columnCount,
    })),
  };
  return sha256CanonicalJson(content);
}

export function arePageResultsIdentical(
  left: ParserPageResultV1,
  right: ParserPageResultV1,
): boolean {
  return computeBlockTableHash(left) === computeBlockTableHash(right);
}

export function buildLineageEntries(entry: ParserRunResultEntry): PageLineageEntry[] {
  return entry.result.pages.map((page) => ({
    parserRunId: entry.parserRunId,
    method: entry.method,
    parserVersion: entry.parserVersion,
    parserConfigSha256: entry.parserConfigSha256,
    sourceSha256: entry.sourceSha256,
    page: page.page,
    outputArtifactSha256: entry.outputArtifactSha256,
  }));
}

interface PageCandidate {
  entry: ParserRunResultEntry;
  pageResult: ParserPageResultV1;
}

function precisionRank(value: EvidencePrecisionV1): number {
  if (value === 'cell_bbox') return 3;
  if (value === 'text_span') return 2;
  return 1;
}

function engineRank(method: ExtractionMethodV1): number {
  const index = ENGINE_PREFERENCE_ORDER.indexOf(method);
  return index === -1 ? ENGINE_PREFERENCE_ORDER.length : index;
}

function sortedUniquePages(pages: readonly number[]): number[] {
  return [...new Set(pages)].sort((a, b) => a - b);
}

function samePages(left: readonly number[], right: readonly number[]): boolean {
  const a = sortedUniquePages(left);
  const b = sortedUniquePages(right);
  return a.length === b.length && a.every((page, index) => page === b[index]);
}

/**
 * The active escalation plan names the exact engine/page work for the current
 * round. Deriving run IDs from that plan prevents an older local result from
 * remaining selected merely because the caller omitted an explicit ID set.
 */
export function deriveEscalationRunIds(
  plan: DefenseBudgetParsePlanV1 | undefined,
  entries: readonly ParserRunResultEntry[],
): Set<string> {
  const output = new Set<string>();
  if (!plan) return output;
  const escalationSteps = plan.steps.filter((step) => !step.reasonCodes.includes('initial_plan'));
  for (const step of escalationSteps) {
    for (const entry of entries) {
      if (entry.method === step.engine && samePages(entry.result.requestedPages, step.pages)) {
        output.add(entry.parserRunId);
      }
    }
  }
  return output;
}

function compareCandidates(
  left: PageCandidate,
  right: PageCandidate,
  escalationRunIds: ReadonlySet<string>,
  policy: SelectionPolicy,
): number {
  if (policy === 'strict_verification_coverage') {
    const leftEscalation = escalationRunIds.has(left.entry.parserRunId);
    const rightEscalation = escalationRunIds.has(right.entry.parserRunId);
    if (leftEscalation !== rightEscalation) return leftEscalation ? -1 : 1;
  }

  const precisionDifference =
    precisionRank(right.pageResult.evidencePrecision) -
    precisionRank(left.pageResult.evidencePrecision);
  if (precisionDifference !== 0) return precisionDifference;

  const engineDifference = engineRank(left.entry.method) - engineRank(right.entry.method);
  if (engineDifference !== 0) return engineDifference;
  return left.entry.parserRunId.localeCompare(right.entry.parserRunId);
}

function selectionReason(
  winner: PageCandidate,
  ordered: readonly PageCandidate[],
  escalationRunIds: ReadonlySet<string>,
): string {
  if (escalationRunIds.has(winner.entry.parserRunId)) {
    return SELECTION_REASON_CODES.RESOLVED_FINDING;
  }
  const runnerUp = ordered.find(
    (candidate) => candidate.entry.parserRunId !== winner.entry.parserRunId,
  );
  if (
    runnerUp &&
    precisionRank(winner.pageResult.evidencePrecision) >
      precisionRank(runnerUp.pageResult.evidencePrecision)
  ) {
    return SELECTION_REASON_CODES.HIGHER_PRECISION;
  }
  if (
    winner.entry.method !== 'llamaparse' &&
    ordered.some((candidate) => candidate.entry.method === 'llamaparse')
  ) {
    return SELECTION_REASON_CODES.PAID_DOES_NOT_OUTRANK;
  }
  if (
    winner.entry.method !== 'paddleocr' &&
    ordered.some((candidate) => candidate.entry.method === 'paddleocr')
  ) {
    return SELECTION_REASON_CODES.OCR_NOT_OVER_CLEAN;
  }
  return SELECTION_REASON_CODES.FIRST_SUCCESSFUL;
}

function selectPage(input: {
  page: number;
  entries: readonly ParserRunResultEntry[];
  escalationRunIds: ReadonlySet<string>;
  policy: SelectionPolicy;
}): SelectedPageResultV1 {
  const successful: PageCandidate[] = [];
  const failures: ParserPageFailureV1[] = [];

  for (const entry of input.entries) {
    const pageResult = entry.result.pages.find((page) => page.page === input.page);
    if (pageResult) successful.push({ entry, pageResult });
    failures.push(...entry.result.failedPages.filter((failure) => failure.page === input.page));
  }

  if (successful.length === 0) {
    return {
      page: input.page,
      selectedParserRunId: null,
      selectionReasonCodes: [
        failures.length > 0 ? SELECTION_REASON_CODES.ALL_FAILED : SELECTION_REASON_CODES.NO_RESULTS,
      ],
      selectedResult: null,
      alternativeParserRunIds: [],
      failures,
    };
  }

  const ordered = [...successful].sort((left, right) =>
    compareCandidates(left, right, input.escalationRunIds, input.policy),
  );
  const winner = ordered[0]!;
  const alternatives = ordered
    .slice(1)
    .filter((candidate) => !arePageResultsIdentical(candidate.pageResult, winner.pageResult))
    .map((candidate) => candidate.entry.parserRunId)
    .sort();

  return {
    page: input.page,
    selectedParserRunId: winner.entry.parserRunId,
    selectionReasonCodes: [selectionReason(winner, ordered, input.escalationRunIds)],
    selectedResult: winner.pageResult,
    alternativeParserRunIds: alternatives,
    failures,
  };
}

export interface ComposeOptions {
  executionId: string;
  sourceSha256: string;
  requestedPages: number[];
  parserRunEntries: readonly ParserRunResultEntry[];
  plan?: DefenseBudgetParsePlanV1;
  escalationRunIds?: Set<string>;
  selectionPolicy?: SelectionPolicy;
}

export function composePageResults(options: ComposeOptions): ComposedPageOutputV1 {
  const policy = options.selectionPolicy ?? DEFAULT_SELECTION_POLICY;
  const escalationRunIds =
    options.escalationRunIds ?? deriveEscalationRunIds(options.plan, options.parserRunEntries);
  const pages = sortedUniquePages(options.requestedPages).map((page) =>
    selectPage({
      page,
      entries: options.parserRunEntries,
      escalationRunIds,
      policy,
    }),
  );
  const lineages = options.parserRunEntries
    .flatMap(buildLineageEntries)
    .sort(
      (left, right) => left.page - right.page || left.parserRunId.localeCompare(right.parserRunId),
    );

  const unsealed: Omit<ComposedPageOutputV1, 'contentSha256'> = {
    schemaVersion: 'defense_budget_composed_output_v1',
    executionId: options.executionId,
    sourceSha256: options.sourceSha256,
    pages,
    lineages,
  };
  return {
    ...unsealed,
    contentSha256: sha256CanonicalJson(unsealed as unknown as JsonValue),
  };
}

export function verifyComposedContentSha(output: ComposedPageOutputV1): boolean {
  try {
    const { contentSha256: _contentSha256, ...unsealed } = output;
    return sha256CanonicalJson(unsealed as unknown as JsonValue) === output.contentSha256;
  } catch {
    return false;
  }
}

export function validatePageCompleteness(pages: SelectedPageResultV1[]): boolean {
  return pages.every((page) => {
    if (page.selectedResult !== null) {
      return page.selectedParserRunId !== null;
    }
    return (
      page.selectedParserRunId === null &&
      page.selectionReasonCodes.length > 0 &&
      (page.failures.length > 0 ||
        page.selectionReasonCodes.includes(SELECTION_REASON_CODES.NO_RESULTS))
    );
  });
}
