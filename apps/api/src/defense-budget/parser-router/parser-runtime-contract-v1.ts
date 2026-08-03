/**
 * defense_budget_parser_runtime_v1 — cross-language parser job/result contract.
 *
 * This is the trust boundary between the Node-side router (which owns
 * manifest interpretation, routing, verification, and audit) and the
 * isolated Python parser runtime (which owns only local parsing).
 *
 * Everything here is runtime-validated with Zod and strict: unknown fields
 * fail closed. No `any` appears in the exported contract.
 *
 * All page numbers are 1-based physical PDF page numbers. Conversion to
 * LlamaParse zero-based pages happens only at the LlamaParse client boundary.
 */
import { z } from 'zod';
import {
  sha256Schema,
  jsonValueSchema,
  jsonMetadataSchema,
} from '../contracts/extraction-artifact-v1.js';
import {
  EXTRACTION_METHOD_V1_VALUES,
  type ExtractionMethodV1,
} from '../contracts/extraction-artifact-v1.js';
import {
  canonicalJsonStringify,
  sha256CanonicalJson,
  sha256Hex,
  type JsonValue,
} from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* A1. Schema version constants                                        */
/* ------------------------------------------------------------------ */

export const DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION = 'defense_budget_parser_job_v1' as const;
export const DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION =
  'defense_budget_parser_result_v1' as const;
export const DEFENSE_BUDGET_PARSE_PLAN_SCHEMA_VERSION = 'defense_budget_parse_plan_v1' as const;

/* ------------------------------------------------------------------ */
/* A2. Parser runtime engine vocabulary                                */
/* ------------------------------------------------------------------ */

/** Engines the Python runtime can execute (excludes llamaparse/manual). */
export const PARSER_RUNTIME_ENGINE_V1_VALUES = [
  'deterministic_pdfplumber',
  'camelot',
  'docling',
  'paddleocr',
] as const;
export const parserRuntimeEngineV1Schema = z.enum(PARSER_RUNTIME_ENGINE_V1_VALUES);
export type ParserRuntimeEngineV1 = z.infer<typeof parserRuntimeEngineV1Schema>;

/* ------------------------------------------------------------------ */
/* A3. Layout block contract                                           */
/* ------------------------------------------------------------------ */

export const layoutBlockV1Schema = z
  .object({
    blockIndex: z.number().int().nonnegative(),
    blockType: z.enum([
      'text',
      'heading',
      'paragraph',
      'list_item',
      'table',
      'image',
      'header',
      'footer',
      'caption',
      'unknown',
    ]),
    text: z.string(),
    readingOrder: z.number().int().nonnegative().optional(),
    boundingBox: z
      .object({
        x0: z.string(),
        y0: z.string(),
        x1: z.string(),
        y1: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type LayoutBlockV1 = z.infer<typeof layoutBlockV1Schema>;

/* ------------------------------------------------------------------ */
/* A4. Parsed table contract                                           */
/* ------------------------------------------------------------------ */

export const parsedTableCellV1Schema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    columnIndex: z.number().int().nonnegative(),
    text: z.string(),
    rowSpan: z.number().int().positive().optional(),
    colSpan: z.number().int().positive().optional(),
    boundingBox: z
      .object({
        x0: z.string(),
        y0: z.string(),
        x1: z.string(),
        y1: z.string(),
      })
      .strict()
      .optional(),
    confidence: z.string().optional(),
  })
  .strict();
export type ParsedTableCellV1 = z.infer<typeof parsedTableCellV1Schema>;

export const parsedTableV1Schema = z
  .object({
    tableIndex: z.number().int().nonnegative(),
    label: z.string().optional(),
    rowCount: z.number().int().nonnegative(),
    columnCount: z.number().int().nonnegative(),
    cells: z.array(parsedTableCellV1Schema),
    boundingBox: z
      .object({
        x0: z.string(),
        y0: z.string(),
        x1: z.string(),
        y1: z.string(),
      })
      .strict()
      .optional(),
    parserReportAccuracy: z.string().optional(),
    warnings: z.array(z.string()),
  })
  .strict();
export type ParsedTableV1 = z.infer<typeof parsedTableV1Schema>;

/* ------------------------------------------------------------------ */
/* A5. Parsed image region contract                                    */
/* ------------------------------------------------------------------ */

export const parsedImageRegionV1Schema = z
  .object({
    imageIndex: z.number().int().nonnegative(),
    boundingBox: z
      .object({
        x0: z.string(),
        y0: z.string(),
        x1: z.string(),
        y1: z.string(),
      })
      .strict()
      .optional(),
    width: z.string().optional(),
    height: z.string().optional(),
    format: z.string().optional(),
  })
  .strict();
export type ParsedImageRegionV1 = z.infer<typeof parsedImageRegionV1Schema>;

/* ------------------------------------------------------------------ */
/* A6. Evidence precision vocabulary                                   */
/* ------------------------------------------------------------------ */

export const EVIDENCE_PRECISION_V1_VALUES = ['page_only', 'text_span', 'cell_bbox'] as const;
export const evidencePrecisionV1Schema = z.enum(EVIDENCE_PRECISION_V1_VALUES);
export type EvidencePrecisionV1 = z.infer<typeof evidencePrecisionV1Schema>;

/* ------------------------------------------------------------------ */
/* A7. Page result contract                                            */
/* ------------------------------------------------------------------ */

export const parserPageResultV1Schema = z
  .object({
    page: z.number().int().positive(),
    width: z.string().optional(),
    height: z.string().optional(),
    rotation: z.number().int().optional(),
    text: z.string().optional(),
    markdown: z.string().optional(),
    printedPage: z.string().optional(),
    blocks: z.array(layoutBlockV1Schema),
    tables: z.array(parsedTableV1Schema),
    images: z.array(parsedImageRegionV1Schema),
    confidence: z.string().optional(),
    evidencePrecision: evidencePrecisionV1Schema,
    warnings: z.array(z.string()),
  })
  .strict();
export type ParserPageResultV1 = z.infer<typeof parserPageResultV1Schema>;

/* ------------------------------------------------------------------ */
/* A8. Page failure contract                                           */
/* ------------------------------------------------------------------ */

export const PARSER_PAGE_FAILURE_CODE_V1_VALUES = [
  'no_embedded_text',
  'page_out_of_range',
  'pdf_parse_error',
  'no_table_detected',
  'table_shape_unstable',
  'coordinate_error',
  'render_error',
  'model_unavailable',
  'timeout',
  'unknown_error',
] as const;
export const parserPageFailureCodeV1Schema = z.enum(PARSER_PAGE_FAILURE_CODE_V1_VALUES);

export const parserPageFailureV1Schema = z
  .object({
    page: z.number().int().positive(),
    code: parserPageFailureCodeV1Schema,
    message: z.string(),
  })
  .strict();
export type ParserPageFailureV1 = z.infer<typeof parserPageFailureV1Schema>;

/* ------------------------------------------------------------------ */
/* A9. Runtime warning contract                                        */
/* ------------------------------------------------------------------ */

export const parserRuntimeWarningV1Schema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    pages: z.array(z.number().int().positive()),
  })
  .strict();
export type ParserRuntimeWarningV1 = z.infer<typeof parserRuntimeWarningV1Schema>;

/* ------------------------------------------------------------------ */
/* A10. Runtime metrics contract                                       */
/* ------------------------------------------------------------------ */

export const parserRuntimeMetricsV1Schema = z
  .object({
    durationMillis: z.number().int().nonnegative(),
    pagesProcessed: z.number().int().nonnegative(),
    pagesSucceeded: z.number().int().nonnegative(),
    pagesFailed: z.number().int().nonnegative(),
    engineVersion: z.string().min(1),
    modelVersions: z.array(z.string()).optional(),
  })
  .strict();
export type ParserRuntimeMetricsV1 = z.infer<typeof parserRuntimeMetricsV1Schema>;

/* ------------------------------------------------------------------ */
/* A11. Job contract                                                   */
/* ------------------------------------------------------------------ */

const sortedUniquePositivePages = z
  .array(z.number().int().positive())
  .min(1)
  .refine(
    (pages) => {
      const sorted = [...pages].sort((a, b) => a - b);
      return pages.every((p, i) => p === sorted[i]);
    },
    { message: 'pages must be sorted ascending' },
  )
  .refine((pages) => new Set(pages).size === pages.length, { message: 'pages must be unique' });

export const parserRuntimeJobV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceSha256: sha256Schema,
    engine: parserRuntimeEngineV1Schema,
    requestedPages: sortedUniquePositivePages,
    parserVersion: z.string().min(1),
    parserConfig: jsonValueSchema,
    parserConfigSha256: sha256Schema,
    outputDirectory: z.string().min(1),
    includeDebugArtifacts: z.boolean(),
  })
  .strict();
export type ParserRuntimeJobV1 = z.infer<typeof parserRuntimeJobV1Schema>;

/* ------------------------------------------------------------------ */
/* A12. Result contract                                                */
/* ------------------------------------------------------------------ */

export const parserRuntimeResultV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PARSER_RESULT_SCHEMA_VERSION),
    jobId: z.string().min(1),
    engine: z.enum(EXTRACTION_METHOD_V1_VALUES),
    parserVersion: z.string().min(1),
    parserConfigSha256: sha256Schema,
    inputSourceSha256: sha256Schema,
    requestedPages: sortedUniquePositivePages,
    succeededPages: z.array(z.number().int().positive()),
    failedPages: z.array(parserPageFailureV1Schema),
    pages: z.array(parserPageResultV1Schema),
    warnings: z.array(parserRuntimeWarningV1Schema),
    metrics: parserRuntimeMetricsV1Schema,
    contentSha256: sha256Schema,
  })
  .strict();
export type ParserRuntimeResultV1 = z.infer<typeof parserRuntimeResultV1Schema>;

/* ------------------------------------------------------------------ */
/* A13. Document execution state machine                              */
/* ------------------------------------------------------------------ */

export const PARSER_DOCUMENT_STATE_V1_VALUES = [
  'PLANNED',
  'RUNNING_LOCAL',
  'LOCAL_COMPLETE',
  'VERIFYING',
  'ESCALATION_PLANNED',
  'RUNNING_PAID',
  'PAID_COMPLETE',
  'TERMINAL_PASSED',
  'TERMINAL_REVIEW',
  'TERMINAL_REJECTED',
  'FAILED',
] as const;
export const parserDocumentStateV1Schema = z.enum(PARSER_DOCUMENT_STATE_V1_VALUES);
export type ParserDocumentStateV1 = z.infer<typeof parserDocumentStateV1Schema>;

/**
 * Allowed state transitions. No terminal state may transition back to a
 * running state within the same execution ID.
 */
export const PARSER_STATE_TRANSITIONS: Record<
  ParserDocumentStateV1,
  readonly ParserDocumentStateV1[]
> = {
  PLANNED: ['RUNNING_LOCAL', 'FAILED'],
  RUNNING_LOCAL: ['LOCAL_COMPLETE', 'FAILED'],
  LOCAL_COMPLETE: ['VERIFYING', 'FAILED'],
  VERIFYING: [
    'ESCALATION_PLANNED',
    'TERMINAL_PASSED',
    'TERMINAL_REVIEW',
    'TERMINAL_REJECTED',
    'FAILED',
  ],
  ESCALATION_PLANNED: ['RUNNING_PAID', 'TERMINAL_REVIEW', 'TERMINAL_REJECTED', 'FAILED'],
  RUNNING_PAID: ['PAID_COMPLETE', 'FAILED'],
  PAID_COMPLETE: ['VERIFYING', 'FAILED'],
  TERMINAL_PASSED: [],
  TERMINAL_REVIEW: [],
  TERMINAL_REJECTED: [],
  FAILED: [],
};

const TERMINAL_STATES: ReadonlySet<ParserDocumentStateV1> = new Set([
  'TERMINAL_PASSED',
  'TERMINAL_REVIEW',
  'TERMINAL_REJECTED',
  'FAILED',
]);

/** Returns true if the state is terminal (no outgoing transitions). */
export function isTerminalState(state: ParserDocumentStateV1): boolean {
  return TERMINAL_STATES.has(state);
}

/** Returns true if the transition from → to is allowed. */
export function isValidTransition(from: ParserDocumentStateV1, to: ParserDocumentStateV1): boolean {
  if (isTerminalState(from)) return false;
  const allowed = PARSER_STATE_TRANSITIONS[from];
  return allowed.includes(to);
}

/** Assert the transition is valid, throw on invalid. */
export function assertValidTransition(
  from: ParserDocumentStateV1,
  to: ParserDocumentStateV1,
): void {
  if (!isValidTransition(from, to)) {
    throw new Error(`invalid parser document state transition: ${from} -> ${to}`);
  }
}

/* ------------------------------------------------------------------ */
/* A14. Parser-run identity (cache key)                                */
/* ------------------------------------------------------------------ */

export interface ParserRunIdentityV1 {
  sourceSha256: string;
  method: ExtractionMethodV1;
  parserVersion: string;
  parserConfigSha256: string;
  pages: readonly number[];
  runtimeContractVersion: string;
}

/**
 * Compute a deterministic cache key from the parser-run identity tuple.
 * The cache key is the canonical-JSON SHA-256 of the identity fields.
 */
export function computeParserRunCacheKey(identity: ParserRunIdentityV1): string {
  const canonical: JsonValue = {
    sourceSha256: identity.sourceSha256,
    method: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    pages: identity.pages.slice().sort((a, b) => a - b),
    runtimeContractVersion: identity.runtimeContractVersion,
  };
  return sha256CanonicalJson(canonical);
}

/**
 * Compute a deterministic parser-run ID from the identity tuple.
 * Uses a different prefix than cache key to distinguish ID from key.
 */
export function computeParserRunId(identity: ParserRunIdentityV1): string {
  const canonical: JsonValue = {
    sourceSha256: identity.sourceSha256,
    method: identity.method,
    parserVersion: identity.parserVersion,
    parserConfigSha256: identity.parserConfigSha256,
    pages: identity.pages.slice().sort((a, b) => a - b),
  };
  return `pr1_${sha256CanonicalJson(canonical)}`;
}

/* ------------------------------------------------------------------ */
/* A15. Helper: compute config SHA from config JSON                    */
/* ------------------------------------------------------------------ */

/**
 * Compute the canonical config SHA-256 from a parser config JSON value.
 * The same config must produce the same SHA in TypeScript and Python.
 */
export function computeParserConfigSha256(config: JsonValue): string {
  return sha256CanonicalJson(config);
}

/* ------------------------------------------------------------------ */
/* A16. Helper: compute result content SHA                             */
/* ------------------------------------------------------------------ */

/**
 * Compute the content SHA-256 of a parser runtime result.
 * Excludes the contentSha256 field itself and metrics.durationMillis
 * (runtime timing) from the hash to ensure determinism.
 */
export function computeResultContentSha256(
  result: Omit<ParserRuntimeResultV1, 'contentSha256'>,
): string {
  const { metrics: rawMetrics, ...rest } = result as ParserRuntimeResultV1;
  const { durationMillis: _ignored, ...stableMetrics } = rawMetrics;
  return sha256CanonicalJson({ ...rest, metrics: stableMetrics } as unknown as JsonValue);
}

/**
 * Validate a complete result, compute content SHA, and return the sealed result.
 */
export function sealParserRuntimeResult(
  result: Omit<ParserRuntimeResultV1, 'contentSha256'>,
): ParserRuntimeResultV1 {
  const contentSha256 = computeResultContentSha256(result);
  const sealed: ParserRuntimeResultV1 = {
    ...(result as ParserRuntimeResultV1),
    contentSha256,
  };
  // Validate the sealed result
  return parserRuntimeResultV1Schema.parse(sealed);
}

/* ------------------------------------------------------------------ */
/* A17. Helper: page-range key for cache paths                        */
/* ------------------------------------------------------------------ */

/**
 * Produce a deterministic page-range key for cache directory naming.
 * E.g. [1,2,3] -> "1-3", [1,3,5] -> "1,3,5", [1,2,3,7,8] -> "1-3,7-8"
 */
export function pageRangeKey(pages: readonly number[]): string {
  if (pages.length === 0) return 'none';
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = sorted[0]!;
  let end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p === end + 1) {
      end = p;
    } else {
      parts.push(start === end ? `${start}` : `${start}-${end}`);
      start = p;
      end = p;
    }
  }
  parts.push(start === end ? `${start}` : `${start}-${end}`);
  return parts.join(',');
}

/* ------------------------------------------------------------------ */
/* A18. Parser artifact descriptor (metadata sidecar)                  */
/* ------------------------------------------------------------------ */

export const parserArtifactDescriptorV1Schema = z
  .object({
    descriptorVersion: z.literal('parser_artifact_descriptor_v1'),
    cacheKey: z.string().min(1),
    parserRunId: z.string().min(1),
    sourceSha256: sha256Schema,
    method: z.enum(EXTRACTION_METHOD_V1_VALUES),
    parserVersion: z.string().min(1),
    parserConfigSha256: sha256Schema,
    requestedPages: z.array(z.number().int().positive()),
    runtimeContractVersion: z.string().min(1),
    contentSha256: sha256Schema,
    byteSha256: sha256Schema,
    resultLocator: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();
export type ParserArtifactDescriptorV1 = z.infer<typeof parserArtifactDescriptorV1Schema>;

/* ------------------------------------------------------------------ */
/* A19. Validation helpers                                             */
/* ------------------------------------------------------------------ */

/** Parse and validate a parser runtime job. Throws ZodError on failure. */
export function parseParserRuntimeJobV1(input: unknown): ParserRuntimeJobV1 {
  return parserRuntimeJobV1Schema.parse(input);
}

/** Parse and validate a parser runtime result. Throws ZodError on failure. */
export function parseParserRuntimeResultV1(input: unknown): ParserRuntimeResultV1 {
  return parserRuntimeResultV1Schema.parse(input);
}

/** Parse and validate a parser artifact descriptor. Throws ZodError on failure. */
export function parseParserArtifactDescriptorV1(input: unknown): ParserArtifactDescriptorV1 {
  return parserArtifactDescriptorV1Schema.parse(input);
}

/**
 * Verify that a result's contentSha256 matches a recomputed hash.
 * Returns true if the hash is valid, false otherwise.
 */
export function verifyResultContentSha256(result: ParserRuntimeResultV1): boolean {
  try {
    // Strip contentSha256, recompute (excluding durationMillis), compare
    const { contentSha256: _ignored, ...rest } = result;
    const recomputed = computeResultContentSha256(rest);
    return recomputed === result.contentSha256;
  } catch {
    return false;
  }
}
