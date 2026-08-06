/** Phase 6 Workstream G — strict NDAA conference language/disposition contract. */
import { z } from 'zod';
import { sha256Schema } from '../../../contracts/extraction-artifact-v1.js';
import {
  provisionActionTypeV1Schema,
  provisionDeadlineV1Schema,
  provisionReferenceV1Schema,
  provisionScopeV1Schema,
  reportingRecipientV1Schema,
} from '../provisions/authorization-provision-v1.js';

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must be nonblank',
  });

export const ndaaConferenceChamberDispositionV1Schema = z
  .object({
    chamber: z.enum(['house', 'senate', 'both']),
    disposition: z.enum(['adopted', 'modified', 'not_adopted', 'receded', 'agreed']),
    rawText: nonBlank,
  })
  .strict();

const boundingBoxSchema = z
  .object({ x0: z.string(), y0: z.string(), x1: z.string(), y1: z.string() })
  .strict();

export const ndaaConferenceLanguageEvidenceV1Schema = z
  .object({
    evidenceId: nonBlank,
    sourceSha256: sha256Schema,
    page: z.number().int().positive(),
    printedPage: z.string().optional(),
    blockIndex: z.number().int().nonnegative(),
    granularity: z.enum(['page_only', 'text_span']),
    excerpt: nonBlank,
    boundingBox: boundingBoxSchema.optional(),
  })
  .strict();

export const ndaaConferenceLanguageProvisionV1Schema = z
  .object({
    schemaVersion: z.literal('ndaa_conference_language_v1'),
    provisionId: nonBlank,
    track: z.literal('authorization'),
    stage: z.literal('ndaa_conference'),
    authority: z.literal('ndaa_conference_authorization'),
    fiscalYear: z.number().int().min(1900).max(2200),
    profileId: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    heading: nonBlank,
    fullText: nonBlank,
    startPage: z.number().int().positive(),
    endPage: z.number().int().positive(),
    printedStart: z.string().optional(),
    printedEnd: z.string().optional(),
    actionType: provisionActionTypeV1Schema,
    deadline: provisionDeadlineV1Schema.optional(),
    reportingRecipient: reportingRecipientV1Schema.optional(),
    references: z.array(provisionReferenceV1Schema),
    scope: provisionScopeV1Schema,
    attributionCaveat: z.string().optional(),
    chamberDispositions: z.array(ndaaConferenceChamberDispositionV1Schema),
    evidenceIds: z.array(nonBlank).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.endPage < value.startPage) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'endPage must be >= startPage' });
    }
    if (
      !['line_specific', 'project_specific'].includes(value.scope) &&
      (value.attributionCaveat == null || value.attributionCaveat.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'non-line-specific provision requires attributionCaveat',
      });
    }
  });

export const ndaaConferenceLanguageExtractionResultV1Schema = z
  .object({
    schemaVersion: z.literal('ndaa_conference_language_extraction_result_v1'),
    stage: z.literal('ndaa_conference'),
    profileId: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    provisions: z.array(ndaaConferenceLanguageProvisionV1Schema),
    evidence: z.array(ndaaConferenceLanguageEvidenceV1Schema),
    warnings: z.array(z.string()),
    omittedPages: z.array(z.number().int().positive()),
  })
  .strict();

export type NdaaConferenceLanguageExtractionResultV1 = z.infer<
  typeof ndaaConferenceLanguageExtractionResultV1Schema
>;
