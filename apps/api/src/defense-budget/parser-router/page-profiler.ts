/**
 * defense_budget_page_profile_v1 — normalized page-profile contract.
 *
 * For every physical page in a source PDF, the profiler produces one record
 * describing page characteristics that the route planner uses to select
 * the initial parser engine. These are routing cues, NOT verification
 * evidence.
 *
 * All page numbers are 1-based physical PDF page numbers.
 * All coordinates/dimensions are canonical decimal strings for cross-language
 * determinism.
 */
import { z } from 'zod';
import { sha256Schema, jsonMetadataSchema } from '../contracts/extraction-artifact-v1.js';
import { DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION } from './parser-runtime-contract-v1.js';

/* ------------------------------------------------------------------ */
/* B1. Page profile record                                            */
/* ------------------------------------------------------------------ */

export const pageProfileV1Schema = z
  .object({
    page: z.number().int().positive(),
    width: z.string(),
    height: z.string(),
    rotation: z.number().int(),
    embeddedTextCharacters: z.number().int().nonnegative(),
    alphanumericCharacters: z.number().int().nonnegative(),
    wordCount: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    imageAreaRatio: z.string(),
    vectorLineCount: z.number().int().nonnegative(),
    horizontalLineCount: z.number().int().nonnegative(),
    verticalLineCount: z.number().int().nonnegative(),
    tableLikeTextLineCount: z.number().int().nonnegative(),
    repeatedHeaderFingerprint: z.string().optional(),
    hasEmbeddedTextLayer: z.boolean(),
    likelyImageOnly: z.boolean(),
    likelyRotated: z.boolean(),
    likelyTablePage: z.boolean(),
    likelyMixedLayout: z.boolean(),
    profileWarnings: z.array(z.string()),
  })
  .strict();
export type PageProfileV1 = z.infer<typeof pageProfileV1Schema>;

/* ------------------------------------------------------------------ */
/* B2. Document-level summary                                         */
/* ------------------------------------------------------------------ */

export const documentProfileSummaryV1Schema = z
  .object({
    pageCount: z.number().int().positive(),
    imageOnlyPageCount: z.number().int().nonnegative(),
    tableLikelyPageCount: z.number().int().nonnegative(),
    mixedLayoutPageCount: z.number().int().nonnegative(),
    rotatedPageCount: z.number().int().nonnegative(),
    zeroContentPageCount: z.number().int().nonnegative(),
    estimatedPdfplumberPages: z.number().int().nonnegative(),
    estimatedCamelotPages: z.number().int().nonnegative(),
    estimatedDoclingPages: z.number().int().nonnegative(),
    estimatedPaddleocrPages: z.number().int().nonnegative(),
    estimatedLlamaparsePages: z.number().int().nonnegative(),
  })
  .strict();
export type DocumentProfileSummaryV1 = z.infer<typeof documentProfileSummaryV1Schema>;

/* ------------------------------------------------------------------ */
/* B3. Document profile result                                        */
/* ------------------------------------------------------------------ */

export const documentProfileResultV1Schema = z
  .object({
    schemaVersion: z.literal('defense_budget_page_profile_v1'),
    sourceSha256: sha256Schema,
    pages: z.array(pageProfileV1Schema),
    summary: documentProfileSummaryV1Schema,
    profileConfigSha256: sha256Schema,
    contentSha256: sha256Schema,
  })
  .strict();
export type DocumentProfileResultV1 = z.infer<typeof documentProfileResultV1Schema>;

/* ------------------------------------------------------------------ */
/* B4. Profiling thresholds (configurable, hashed)                    */
/* ------------------------------------------------------------------ */

export const profilingThresholdsV1Schema = z
  .object({
    minimumEmbeddedTextCharacters: z.number().int().positive(),
    minimumAlphanumericCharacters: z.number().int().positive(),
    imageOnlyAreaRatio: z.number().min(0).max(1),
    rotationDegreesRequiringCorrection: z.array(z.number().int()),
    minimumTableLikeTextLines: z.number().int().positive(),
    minimumVectorLinesForTableCue: z.number().int().positive(),
  })
  .strict();
export type ProfilingThresholdsV1 = z.infer<typeof profilingThresholdsV1Schema>;

export const DEFAULT_PROFILING_THRESHOLDS: ProfilingThresholdsV1 = {
  minimumEmbeddedTextCharacters: 40,
  minimumAlphanumericCharacters: 20,
  imageOnlyAreaRatio: 0.8,
  rotationDegreesRequiringCorrection: [90, 180, 270, -90, -180, -270],
  minimumTableLikeTextLines: 3,
  minimumVectorLinesForTableCue: 6,
};

/* ------------------------------------------------------------------ */
/* B5. Profile request (job envelope for the Python runtime)         */
/* ------------------------------------------------------------------ */

export const profileJobV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PARSER_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceSha256: sha256Schema,
    engine: z.literal('deterministic_pdfplumber'),
    requestedPages: z.array(z.number().int().positive()),
    parserVersion: z.string().min(1),
    parserConfig: jsonMetadataSchema,
    parserConfigSha256: sha256Schema,
    outputDirectory: z.string().min(1),
    includeDebugArtifacts: z.boolean(),
  })
  .strict();
export type ProfileJobV1 = z.infer<typeof profileJobV1Schema>;

/* ------------------------------------------------------------------ */
/* B6. Helpers                                                       */
/* ------------------------------------------------------------------ */

import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

/** Compute config SHA for profiling thresholds. */
export function computeProfilingConfigSha256(thresholds: ProfilingThresholdsV1): string {
  return sha256CanonicalJson(thresholds as unknown as JsonValue);
}

/** Compute content SHA for a document profile result (excluding the field itself). */
export function computeProfileContentSha256(
  result: Omit<DocumentProfileResultV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(result as unknown as JsonValue);
}

/** Parse and validate a document profile result. */
export function parseDocumentProfileResultV1(input: unknown): DocumentProfileResultV1 {
  return documentProfileResultV1Schema.parse(input);
}
