/**
 * Shared adapter context for legacy-artifact -> V1 conversion.
 *
 * Every adapter receives the same validated context: source identity plus the
 * parser-run metadata that produced the legacy artifact. Adapters must not
 * invent context values; the caller (CLI or test) supplies them.
 */
import { z } from 'zod';
import {
  budgetAuthorityV1Schema,
  budgetComponentV1Schema,
  budgetFamilyV1Schema,
  exhibitV1Schema,
  extractionMethodV1Schema,
  extractionSourceV1Schema,
  pageRangeV1Schema,
  sha256Schema,
  type ExtractionSourceV1,
  type ParserRunV1,
} from '../extraction-artifact-v1.js';
import { parserRunIdV1 } from '../artifact-builders.js';

const nonBlankString = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, {
    message: 'must be nonblank',
  });

export const extractionAdapterContextV1Schema = z
  .object({
    manifestDocumentKey: nonBlankString,
    sourceDocumentId: z.string().optional(),
    sourcePdfSha256: sha256Schema,
    sourceLocator: nonBlankString,
    sourceUrl: z.string().optional(),
    fiscalYear: z.number().int().min(1900).max(2200),
    family: budgetFamilyV1Schema,
    exhibit: exhibitV1Schema,
    authority: budgetAuthorityV1Schema,
    component: budgetComponentV1Schema,
    budgetCycle: nonBlankString,
    documentType: nonBlankString,
    pageCount: z.number().int().positive().optional(),
    title: z.string().optional(),
    parser: z
      .object({
        method: extractionMethodV1Schema,
        parserVersion: nonBlankString,
        parserConfigSha256: sha256Schema,
        outputArtifactSha256: sha256Schema,
        pageRanges: z.array(pageRangeV1Schema),
        providerJobId: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type ExtractionAdapterContextV1 = z.infer<typeof extractionAdapterContextV1Schema>;

/** Validate raw context input before conversion. Throws on invalid context. */
export function parseExtractionAdapterContextV1(input: unknown): ExtractionAdapterContextV1 {
  return extractionAdapterContextV1Schema.parse(input);
}

/** Build the artifact source object from a validated context. */
export function sourceFromContext(context: ExtractionAdapterContextV1): ExtractionSourceV1 {
  const parsed = extractionSourceV1Schema.parse({
    manifestDocumentKey: context.manifestDocumentKey,
    sourcePdfSha256: context.sourcePdfSha256,
    sourceLocator: context.sourceLocator,
    fiscalYear: context.fiscalYear,
    family: context.family,
    exhibit: context.exhibit,
    authority: context.authority,
    component: context.component,
    budgetCycle: context.budgetCycle,
    documentType: context.documentType,
    ...(context.sourceDocumentId != null ? { sourceDocumentId: context.sourceDocumentId } : {}),
    ...(context.sourceUrl != null ? { sourceUrl: context.sourceUrl } : {}),
    ...(context.pageCount != null ? { pageCount: context.pageCount } : {}),
    ...(context.title != null ? { title: context.title } : {}),
  });
  return parsed;
}

/**
 * Build the single deterministic parser run for a legacy conversion.
 * The parser run ID is a hash of the run's identity tuple, so replaying the
 * same conversion produces the same ID.
 */
export function parserRunFromContext(context: ExtractionAdapterContextV1): ParserRunV1 {
  const identity = {
    method: context.parser.method,
    parserVersion: context.parser.parserVersion,
    parserConfigSha256: context.parser.parserConfigSha256,
    inputSourceSha256: context.sourcePdfSha256,
    outputArtifactSha256: context.parser.outputArtifactSha256,
    pageRanges: context.parser.pageRanges,
    providerJobId: context.parser.providerJobId ?? null,
  };
  return {
    parserRunId: parserRunIdV1(identity),
    method: context.parser.method,
    parserVersion: context.parser.parserVersion,
    parserConfigSha256: context.parser.parserConfigSha256,
    inputSourceSha256: context.sourcePdfSha256,
    outputArtifactSha256: context.parser.outputArtifactSha256,
    pageRanges: context.parser.pageRanges,
    ...(context.parser.providerJobId != null
      ? { providerJobId: context.parser.providerJobId }
      : {}),
  };
}
