/**
 * Workstream J — Targeted LlamaParse page executor.
 *
 * Uses the existing LlamaParse client safely for only the unresolved
 * authorized pages. The LlamaParse client stays in TypeScript — there
 * is no Python LlamaParse implementation.
 *
 * Responsibilities:
 * - 1-based → 0-based page conversion (single pure helper, J2)
 * - Mode selection (J4): complex→pdf_premium, OCR→pdf_ocr, fast→pdf_fast
 * - Page-range submission via targetPages (J3)
 * - Result normalization into ParserRuntimeResultV1 (J5)
 * - Archive and proof metadata (J6)
 * - Failure behavior: provider error, timeout, partial success (J7)
 * - Paid authorization enforcement (J8): no flag → no call, flag
 *   without cap → fail, plan above cap → fail before call, proven
 *   cache → no call, corrupt cache + no auth → fail, API key redacted
 *
 * Canonical promotion is NOT performed here. This executor produces
 * parser-run artifacts only.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type LlamaParseClient,
  type LlamaParseJobResult,
  type ParseMode,
  type FetchLike,
  type MultipartForm,
} from '../llamaparse.client.js';
import { adaptLlamaParseJson, parseMarkdownTables } from '../extractors/llamaparse-adapter.js';
import type { ParsedPage } from '../extractors/rdte.extractor.types.js';
import {
  sealParserRuntimeResult,
  computeParserConfigSha256,
  computeResultContentSha256,
  pageRangeKey,
  computeParserRunId,
  computeParserRunCacheKey,
  type ParserRuntimeResultV1,
  type ParserPageResultV1,
  type ParserPageFailureV1,
  type ParserRuntimeWarningV1,
  type ParserRuntimeMetricsV1,
  type ParserArtifactDescriptorV1,
  type EvidencePrecisionV1,
  type LayoutBlockV1,
  type ParsedTableV1,
  type ParsedTableCellV1,
} from './parser-runtime-contract-v1.js';
import type { ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';
import { sha256Hex, sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* J2. One-based to zero-based conversion                              */
/* ------------------------------------------------------------------ */

/**
 * Convert 1-based physical PDF page numbers to 0-based LlamaParse
 * target_pages indices.
 *
 * Rules:
 * - Input must be positive, sorted, and unique.
 * - Output equals each input minus one.
 * - No other caller performs this subtraction.
 */
export function toLlamaTargetPages(oneBasedPages: number[]): number[] {
  if (oneBasedPages.length === 0) {
    throw new Error('toLlamaTargetPages: pages must be non-empty');
  }
  // Validate positive
  for (const p of oneBasedPages) {
    if (!Number.isInteger(p) || p < 1) {
      throw new Error(`toLlamaTargetPages: page ${p} must be a positive integer`);
    }
  }
  // Validate sorted
  for (let i = 1; i < oneBasedPages.length; i++) {
    if (oneBasedPages[i]! < oneBasedPages[i - 1]!) {
      throw new Error('toLlamaTargetPages: pages must be sorted ascending');
    }
  }
  // Validate unique
  const seen = new Set<number>();
  for (const p of oneBasedPages) {
    if (seen.has(p)) {
      throw new Error(`toLlamaTargetPages: duplicate page ${p}`);
    }
    seen.add(p);
  }
  return oneBasedPages.map((p) => p - 1);
}

/* ------------------------------------------------------------------ */
/* J4. Mode selection                                                  */
/* ------------------------------------------------------------------ */

export type LlamaParsePageType = 'complex_digital' | 'image_ocr' | 'fast';

export interface PaidModeConfig {
  /** Operator override for --paid-mode. */
  operatorOverride?: ParseMode;
  /** Per-page type mapping. */
  pageTypeMap?: Partial<Record<LlamaParsePageType, ParseMode>>;
}

const DEFAULT_MODE_MAP: Record<LlamaParsePageType, ParseMode> = {
  complex_digital: 'pdf_premium',
  image_ocr: 'pdf_ocr',
  fast: 'pdf_fast',
};

/**
 * Select the LlamaParse mode for a set of pages.
 *
 * Default mapping:
 * - complex digital pages -> pdf_premium
 * - image/OCR unresolved pages -> pdf_ocr
 * - explicit operator fast mode -> pdf_fast
 *
 * The operator may override with --paid-mode.
 */
export function selectParseMode(pageType: LlamaParsePageType, config?: PaidModeConfig): ParseMode {
  if (config?.operatorOverride) {
    return config.operatorOverride;
  }
  const map = { ...DEFAULT_MODE_MAP, ...(config?.pageTypeMap ?? {}) };
  return map[pageType] ?? DEFAULT_MODE_MAP[pageType];
}

/**
 * Build the parser config that will be hashed.
 */
export function buildLlamaParseConfig(
  mode: ParseMode,
  targetPages: number[],
  pageType: LlamaParsePageType,
): JsonValue {
  return {
    mode,
    targetPages,
    pageType,
    resultType: 'both',
  } as JsonValue;
}

/**
 * Compute the parser config SHA-256.
 */
export function computeLlamaParseConfigSha(
  mode: ParseMode,
  targetPages: number[],
  pageType: LlamaParsePageType,
): string {
  return computeParserConfigSha256(buildLlamaParseConfig(mode, targetPages, pageType));
}

/* ------------------------------------------------------------------ */
/* J5. Result normalization                                            */
/* ------------------------------------------------------------------ */

/**
 * Normalize LlamaParse output pages (from adaptLlamaParseJson) into
 * ParserPageResultV1 page results.
 *
 * If provider output lacks cell geometry, evidence remains page-only.
 */
export function normalizeLlamaParsePages(
  pages: ParsedPage[],
  requestedPages: number[],
): ParserPageResultV1[] {
  const results: ParserPageResultV1[] = [];
  const requestedSet = new Set(requestedPages);

  for (const page of pages) {
    const pageNumber = page.pdfPage;
    if (!requestedSet.has(pageNumber)) continue;

    // Build blocks from markdown text
    const blocks: LayoutBlockV1[] = [];
    const text = page.markdown ?? '';
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      let blockType: LayoutBlockV1['blockType'] = 'text';
      if (line.startsWith('#')) {
        blockType = 'heading';
      } else if (line.startsWith('|')) {
        // Table rows are not text blocks
        continue;
      }
      blocks.push({
        blockIndex: i,
        blockType,
        text: line.trim(),
        readingOrder: i,
      });
    }

    // Build tables
    const tables: ParsedTableV1[] = [];
    for (let tIdx = 0; tIdx < page.tables.length; tIdx++) {
      const table = page.tables[tIdx]!;
      const header = table.header ?? [];
      const rows = table.rows ?? [];
      const rowCount = rows.length + (header.length > 0 ? 1 : 0);
      const columnCount = header.length || (rows[0]?.length ?? 0);
      const cells: ParsedTableCellV1[] = [];

      if (header.length > 0) {
        for (let c = 0; c < header.length; c++) {
          cells.push({
            rowIndex: 0,
            columnIndex: c,
            text: header[c] ?? '',
          });
        }
      }
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r]!;
        for (let c = 0; c < row.length; c++) {
          cells.push({
            rowIndex: r + (header.length > 0 ? 1 : 0),
            columnIndex: c,
            text: row[c] ?? '',
          });
        }
      }

      tables.push({
        tableIndex: tIdx,
        label: table.label,
        rowCount,
        columnCount,
        cells,
        warnings: [],
      });
    }

    // Determine evidence precision
    // LlamaParse rarely provides cell-level bounding boxes in JSON output,
    // so evidence defaults to page_only unless we have structured tables.
    const evidencePrecision: EvidencePrecisionV1 = tables.length > 0 ? 'page_only' : 'page_only';

    results.push({
      page: pageNumber,
      text: text || undefined,
      markdown: text || undefined,
      printedPage: page.printedPage ?? undefined,
      blocks,
      tables,
      images: [],
      evidencePrecision,
      warnings: [],
    });
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* J6. Archive and proof                                               */
/* ------------------------------------------------------------------ */

/**
 * Metadata recorded for each LlamaParse parser run.
 */
export interface LlamaParseRunProofV1 {
  providerJobId: string;
  inputSourceSha256: string;
  selectedPages: number[];
  mode: ParseMode;
  outputByteSha256: string;
  normalizedResultSha256: string;
  s3Locator?: string;
  s3Version?: string;
  creditsUsed?: number;
}

/**
 * Compute the SHA-256 of raw bytes.
 */
export function computeByteSha256(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Build a parser-run proof record from a LlamaParse execution.
 */
export function buildLlamaParseRunProof(
  providerJobId: string,
  inputSourceSha256: string,
  selectedPages: number[],
  mode: ParseMode,
  rawMarkdown: string,
  rawJson: unknown,
  result: ParserRuntimeResultV1,
  s3Locator?: string,
  s3Version?: string,
  creditsUsed?: number,
): LlamaParseRunProofV1 {
  // Combine raw outputs for byte SHA
  const combinedRaw = Buffer.from(JSON.stringify({ markdown: rawMarkdown, json: rawJson }), 'utf8');
  return {
    providerJobId,
    inputSourceSha256,
    selectedPages: [...selectedPages].sort((a, b) => a - b),
    mode,
    outputByteSha256: computeByteSha256(combinedRaw),
    normalizedResultSha256: result.contentSha256,
    s3Locator,
    s3Version,
    creditsUsed,
  };
}

/* ------------------------------------------------------------------ */
/* J7/J8. Paid authorization                                           */
/* ------------------------------------------------------------------ */

export interface PaidAuthorization {
  allowPaidParse: boolean;
  maxPaidPages: number;
  paidMode?: ParseMode;
}

/**
 * Validate the paid authorization. Throws on invalid configuration.
 */
export function validatePaidAuthorization(auth: PaidAuthorization): void {
  if (auth.allowPaidParse && (!auth.maxPaidPages || auth.maxPaidPages <= 0)) {
    throw new Error('--allow-paid-parse requires --max-paid-pages with a positive integer');
  }
}

/**
 * Check if a paid call is authorized for the given page count.
 * Throws if the plan exceeds the cap.
 */
export function assertPaidPageCap(plannedPages: number[], auth: PaidAuthorization): void {
  if (!auth.allowPaidParse) {
    if (plannedPages.length > 0) {
      throw new Error('paid parse is not authorized (--allow-paid-parse not set)');
    }
    return;
  }
  if (plannedPages.length > auth.maxPaidPages) {
    throw new Error(
      `planned paid pages (${plannedPages.length}) exceed cap (${auth.maxPaidPages})`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* J3. LlamaParse page executor                                        */
/* ------------------------------------------------------------------ */

export interface LlamaParseExecutorOptions {
  sourceSha256: string;
  sourcePdfBuffer: Buffer;
  sourceFilename: string;
  requestedPages: number[];
  pageType: LlamaParsePageType;
  authorization: PaidAuthorization;
  paidModeConfig?: PaidModeConfig;
  /** Existing client to reuse (tests can inject a mock). */
  client?: LlamaParseClient;
  /** Client config for constructing a new client if none provided. */
  clientConfig?: {
    apiKey: string;
    baseUrl: string;
    pollIntervalMs?: number;
    pollTimeoutMs?: number;
  };
  fetchImpl?: FetchLike;
  /** Cached proven result — if present and valid, no paid call is made. */
  cachedResult?: ParserRuntimeResultV1 | null;
  /** Artifact store for archiving raw output. */
  artifactStore?: {
    writeRaw(jobId: string, data: Buffer): Promise<string>;
  };
  jobId: string;
}

/**
 * Execute a targeted LlamaParse call on only the authorized unresolved pages.
 *
 * Returns a ParserRuntimeResultV1 with normalized page results.
 *
 * Throws if:
 * - Authorization is missing or insufficient
 * - The planned pages exceed the paid cap
 * - The provider returns an error (with API key redacted)
 * - A corrupt cached result is present without authorization
 */
export async function executeLlamaParsePages(
  opts: LlamaParseExecutorOptions,
): Promise<{ result: ParserRuntimeResultV1; proof: LlamaParseRunProofV1 | null }> {
  // J8: no flag -> no client construction/call
  if (!opts.authorization.allowPaidParse) {
    if (opts.cachedResult) {
      // Check if cache is valid
      const recomputed = computeResultContentSha256(stripContentSha(opts.cachedResult));
      if (recomputed === opts.cachedResult.contentSha256) {
        // Proven cache → no call
        return { result: opts.cachedResult, proof: null };
      }
      // Corrupt cache + no authorization → fail, no call
      throw new Error(
        'cached result is corrupt (SHA mismatch) and no paid authorization is present to retry',
      );
    }
    throw new Error('paid parse is not authorized (--allow-paid-parse not set)');
  }

  // Validate authorization
  validatePaidAuthorization(opts.authorization);

  // J8: plan above cap -> fail before call
  assertPaidPageCap(opts.requestedPages, opts.authorization);

  // J2: convert to 0-based pages
  const targetPages = toLlamaTargetPages(opts.requestedPages);

  // J8: proven cache -> no call
  if (opts.cachedResult) {
    const recomputed = computeResultContentSha256(stripContentSha(opts.cachedResult));
    if (recomputed === opts.cachedResult.contentSha256) {
      return { result: opts.cachedResult, proof: null };
    }
    // Corrupt cache with authorization present → proceed to paid call
    // (the authorization is already validated above)
  }

  // J4: mode selection
  const mode = selectParseMode(opts.pageType, opts.paidModeConfig);

  // Config SHA
  const configSha = computeLlamaParseConfigSha(mode, targetPages, opts.pageType);

  // J1: reuse existing client or construct one
  let client = opts.client;
  if (!client) {
    if (!opts.clientConfig) {
      throw new Error('either client or clientConfig must be provided');
    }
    // Lazy import to avoid circular dependencies in test
    const { LlamaParseClient: LPC } = await import('../llamaparse.client.js');
    client = new LPC(
      {
        apiKey: opts.clientConfig.apiKey,
        baseUrl: opts.clientConfig.baseUrl,
        pollIntervalMs: opts.clientConfig.pollIntervalMs,
        pollTimeoutMs: opts.clientConfig.pollTimeoutMs,
      },
      opts.fetchImpl ?? (globalThis.fetch as FetchLike),
    );
  }

  // J3: submit only selected pages
  const startTime = Date.now();
  let jobResult: LlamaParseJobResult;
  try {
    jobResult = await client.parse({
      file: opts.sourcePdfBuffer,
      filename: opts.sourceFilename,
      mode,
      resultType: 'both',
      targetPages,
    });
  } catch (err) {
    // J7: provider error -> explicit page failures
    // J8: API key redacted from errors (client already redacts)
    const elapsed = Date.now() - startTime;
    return buildFailureResult(
      opts.jobId,
      opts.requestedPages,
      opts.sourceSha256,
      configSha,
      err instanceof Error ? err.message : String(err),
      elapsed,
      'unknown_error',
    );
  }

  // J7: ERROR or CANCELED status
  if (jobResult.status === 'ERROR' || jobResult.status === 'CANCELED') {
    const elapsed = Date.now() - startTime;
    return buildFailureResult(
      opts.jobId,
      opts.requestedPages,
      opts.sourceSha256,
      configSha,
      `LlamaParse job ${jobResult.status.toLowerCase()}`,
      elapsed,
      'unknown_error',
    );
  }

  // J5: normalize results
  const rawMarkdown = jobResult.markdown ?? '';
  const rawJson = jobResult.json ?? {};
  const adaptedPages = adaptLlamaParseJson(rawJson, { markdownFallback: rawMarkdown });
  const pageResults = normalizeLlamaParsePages(adaptedPages, opts.requestedPages);

  // J7: partial success — preserve successful pages and fail missing pages
  const succeededPages: number[] = pageResults.map((p) => p.page);
  const failedPages: ParserPageFailureV1[] = [];
  for (const reqPage of opts.requestedPages) {
    if (!succeededPages.includes(reqPage)) {
      failedPages.push({
        page: reqPage,
        code: 'no_embedded_text',
        message: `LlamaParse returned no result for page ${reqPage}`,
      });
    }
  }

  const elapsed = Date.now() - startTime;
  const warnings: ParserRuntimeWarningV1[] = [];
  if (failedPages.length > 0) {
    warnings.push({
      code: 'partial_success',
      message: `${failedPages.length} page(s) missing from LlamaParse result`,
      pages: failedPages.map((f) => f.page),
    });
  }

  const metrics: ParserRuntimeMetricsV1 = {
    durationMillis: elapsed,
    pagesProcessed: opts.requestedPages.length,
    pagesSucceeded: succeededPages.length,
    pagesFailed: failedPages.length,
    engineVersion: 'llamaparse-v1',
    modelVersions: ['llamaparse'],
  };

  const unsealedResult: Omit<ParserRuntimeResultV1, 'contentSha256'> = {
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId: opts.jobId,
    engine: 'llamaparse' as ExtractionMethodV1,
    parserVersion: 'llamaparse-v1',
    parserConfigSha256: configSha,
    inputSourceSha256: opts.sourceSha256,
    requestedPages: opts.requestedPages,
    succeededPages,
    failedPages,
    pages: pageResults,
    warnings,
    metrics,
  };

  const result = sealParserRuntimeResult(stripUndefined(unsealedResult));

  // J6: archive and proof
  let s3Locator: string | undefined;
  let s3Version: string | undefined;
  if (opts.artifactStore) {
    const rawBuffer = Buffer.from(JSON.stringify({ markdown: rawMarkdown, json: rawJson }), 'utf8');
    const locator = await opts.artifactStore.writeRaw(opts.jobId, rawBuffer);
    s3Locator = locator;
    s3Version = computeByteSha256(rawBuffer);
  }

  const proof = buildLlamaParseRunProof(
    jobResult.jobId,
    opts.sourceSha256,
    opts.requestedPages,
    mode,
    rawMarkdown,
    rawJson,
    result,
    s3Locator,
    s3Version,
    jobResult.creditsUsed,
  );

  return { result, proof };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Strip contentSha256 for re-computation. */
function stripContentSha(
  result: ParserRuntimeResultV1,
): Omit<ParserRuntimeResultV1, 'contentSha256'> {
  const { contentSha256: _, ...rest } = result;
  return stripUndefined(rest) as Omit<ParserRuntimeResultV1, 'contentSha256'>;
}

/**
 * Recursively remove undefined values from an object so it is JSON-safe
 * for canonical hashing.
 */
function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

/** Build a failure-only result (all pages failed, no successful pages). */
function buildFailureResult(
  jobId: string,
  requestedPages: number[],
  sourceSha256: string,
  configSha: string,
  errorMessage: string,
  elapsedMs: number,
  failureCode: ParserPageFailureV1['code'],
): { result: ParserRuntimeResultV1; proof: null } {
  const failedPages: ParserPageFailureV1[] = requestedPages.map((page) => ({
    page,
    code: failureCode,
    message: errorMessage,
  }));

  const warnings: ParserRuntimeWarningV1[] = [
    {
      code: 'llamaparse_error',
      message: errorMessage,
      pages: requestedPages,
    },
  ];

  const metrics: ParserRuntimeMetricsV1 = {
    durationMillis: elapsedMs,
    pagesProcessed: requestedPages.length,
    pagesSucceeded: 0,
    pagesFailed: requestedPages.length,
    engineVersion: 'llamaparse-v1',
    modelVersions: ['llamaparse'],
  };

  const unsealed: Omit<ParserRuntimeResultV1, 'contentSha256'> = {
    schemaVersion: 'defense_budget_parser_result_v1',
    jobId,
    engine: 'llamaparse' as ExtractionMethodV1,
    parserVersion: 'llamaparse-v1',
    parserConfigSha256: configSha,
    inputSourceSha256: sourceSha256,
    requestedPages,
    succeededPages: [],
    failedPages,
    pages: [],
    warnings,
    metrics,
  };

  return { result: sealParserRuntimeResult(stripUndefined(unsealed)), proof: null };
}
