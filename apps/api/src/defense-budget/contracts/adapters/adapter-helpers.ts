/**
 * Common helpers shared by legacy-artifact adapters.
 *
 * These helpers enforce the two truthfulness rules of the contract:
 *   1. Evidence is never fabricated — missing page provenance becomes
 *      `document_only`, never a coerced page or invented bounding box.
 *   2. Facts are never silently dropped — every enumerated source fact must be
 *      consumed by an assertion or exactly one omission.
 */
import { evidenceIdV1, factIdV1, omissionIdV1, warningIdV1 } from '../artifact-builders.js';
import type { JsonValue } from '../canonical-json.js';
import type {
  EvidenceGranularityV1,
  ExtractionOmissionV1,
  ExtractionWarningV1,
  OmissionReasonV1,
  SourceEvidenceV1,
  SourceFactCategoryV1,
  SourceFactV1,
} from '../extraction-artifact-v1.js';
import type { ExtractionAdapterContextV1 } from './adapter-context.js';

/* ------------------------------------------------------------------ */
/* evidence                                                            */
/* ------------------------------------------------------------------ */

export interface EvidenceInput {
  parserRunId: string;
  /** 1-based page when the legacy artifact truthfully carries one. */
  page?: number;
  printedPage?: string;
  tableLabel?: string;
  rowLabel?: string;
  columnLabel?: string;
  excerpt?: string;
  /** Distinguishes otherwise-identical evidence tuples (e.g. source path). */
  discriminator?: string;
}

/**
 * Create truthful evidence: `page_only` when a page exists, `document_only`
 * otherwise. Pages are never coerced and boxes are never invented.
 */
export function buildTruthfulEvidence(
  context: ExtractionAdapterContextV1,
  input: EvidenceInput,
): SourceEvidenceV1 {
  const granularity: EvidenceGranularityV1 = input.page != null ? 'page_only' : 'document_only';
  const identity = {
    sourcePdfSha256: context.sourcePdfSha256,
    parserRunId: input.parserRunId,
    granularity,
    page: input.page ?? null,
    printedPage: input.printedPage ?? null,
    tableLabel: input.tableLabel ?? null,
    rowLabel: input.rowLabel ?? null,
    columnLabel: input.columnLabel ?? null,
    excerpt: input.excerpt ?? null,
    discriminator: input.discriminator ?? null,
  };
  return {
    evidenceId: evidenceIdV1(identity),
    sourcePdfSha256: context.sourcePdfSha256,
    parserRunId: input.parserRunId,
    granularity,
    ...(input.page != null ? { page: input.page } : {}),
    ...(input.printedPage != null ? { printedPage: input.printedPage } : {}),
    ...(input.tableLabel != null ? { tableLabel: input.tableLabel } : {}),
    ...(input.rowLabel != null ? { rowLabel: input.rowLabel } : {}),
    ...(input.columnLabel != null ? { columnLabel: input.columnLabel } : {}),
    ...(input.excerpt != null ? { excerpt: input.excerpt } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* source facts                                                        */
/* ------------------------------------------------------------------ */

export interface SourceFactInput {
  sourcePath: string;
  category: SourceFactCategoryV1;
  requiredForCompleteness: boolean;
  rawValue?: JsonValue;
  evidenceIds: string[];
}

/** Create a source fact with a deterministic ID over its identity tuple. */
export function buildSourceFact(input: SourceFactInput): SourceFactV1 {
  return {
    factId: factIdV1({
      sourcePath: input.sourcePath,
      category: input.category,
      rawValue: input.rawValue ?? null,
    }),
    sourcePath: input.sourcePath,
    category: input.category,
    requiredForCompleteness: input.requiredForCompleteness,
    ...(input.rawValue !== undefined ? { rawValue: input.rawValue } : {}),
    evidenceIds: input.evidenceIds,
  };
}

/* ------------------------------------------------------------------ */
/* omissions + warnings                                                */
/* ------------------------------------------------------------------ */

export function buildOmission(input: {
  sourceFactId: string;
  reason: OmissionReasonV1;
  severity: 'review' | 'blocking';
  message: string;
}): ExtractionOmissionV1 {
  return {
    omissionId: omissionIdV1({
      sourceFactId: input.sourceFactId,
      reason: input.reason,
      message: input.message,
    }),
    sourceFactId: input.sourceFactId,
    reason: input.reason,
    severity: input.severity,
    message: input.message,
  };
}

export function buildWarning(input: {
  code: string;
  severity: 'info' | 'review' | 'blocking';
  message: string;
  sourceFactIds?: string[];
  evidenceIds?: string[];
  discriminator?: string;
}): ExtractionWarningV1 {
  return {
    warningId: warningIdV1({
      code: input.code,
      message: input.message,
      sourceFactIds: input.sourceFactIds ?? [],
      evidenceIds: input.evidenceIds ?? [],
      discriminator: input.discriminator ?? null,
    }),
    code: input.code,
    severity: input.severity,
    message: input.message,
    sourceFactIds: input.sourceFactIds ?? [],
    evidenceIds: input.evidenceIds ?? [],
  };
}
