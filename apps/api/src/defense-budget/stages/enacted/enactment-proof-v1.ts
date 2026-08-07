/** Phase 6 Workstream L — strict enacted-proof chain. */
import { z } from 'zod';
import { stripUndefinedProperties } from '../../contracts/canonical-json.js';
import {
  budgetLineIdentityV1Schema,
  moneyValueV1Schema,
  sha256Schema,
  type BudgetLineIdentityV1,
  type MoneyValueV1,
} from '../../contracts/extraction-artifact-v1.js';

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const sourceProofSchema = z
  .object({
    manifestDocumentKey: nonBlank,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    status: z.enum(['current', 'superseded']),
  })
  .strict();

export const DEFENSE_BUDGET_ENACTMENT_PROOF_FIELD = 'defense_budget_enactment_proof_v1' as const;

export const ENACTMENT_PROOF_TYPE_VALUES = [
  'statutory_line_item',
  'incorporated_explanatory_statement',
  'incorporated_table',
  'other_reviewed',
] as const;
export const enactmentProofTypeV1Schema = z.enum(ENACTMENT_PROOF_TYPE_VALUES);

export const defenseBudgetEnactmentProofV1Schema = z
  .object({
    schemaVersion: z.literal('defense_budget_enactment_proof_v1'),
    proofId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    publicLawNumber: nonBlank,
    enactmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    billId: nonBlank,
    vehicleKind: z.enum(['full_year', 'continuing_resolution']),
    division: nonBlank.optional(),
    title: nonBlank.optional(),
    section: nonBlank.optional(),
    publicLawSource: sourceProofSchema,
    lineDetailSource: sourceProofSchema,
    proofType: enactmentProofTypeV1Schema,
    incorporationEvidence: z
      .object({
        citation: nonBlank,
        sourceDocumentId: nonBlank,
        sourceSha256: sha256Schema,
        evidenceIds: z.array(nonBlank).min(1),
        textSpan: z
          .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    vehicleProfileHash: sha256Schema,
    reviewerStatus: z.enum(['verified', 'reviewed', 'pending', 'rejected']),
    explicitLineAuthority: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    const incorporated = [
      'incorporated_explanatory_statement',
      'incorporated_table',
      'other_reviewed',
    ].includes(value.proofType);
    if (incorporated && value.incorporationEvidence == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'incorporated enactment proof requires incorporation evidence',
        path: ['incorporationEvidence'],
      });
    }
    if (value.incorporationEvidence != null) {
      if (
        value.incorporationEvidence.sourceDocumentId !== value.publicLawSource.sourceDocumentId ||
        value.incorporationEvidence.sourceSha256 !== value.publicLawSource.sourceSha256
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'incorporation evidence must be bound to the exact public-law source',
          path: ['incorporationEvidence'],
        });
      }
    }
    if (value.proofType === 'statutory_line_item') {
      if (
        value.lineDetailSource.sourceDocumentId !== value.publicLawSource.sourceDocumentId ||
        value.lineDetailSource.sourceSha256 !== value.publicLawSource.sourceSha256 ||
        value.lineDetailSource.manifestDocumentKey !== value.publicLawSource.manifestDocumentKey
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'statutory_line_item requires the public law itself to be the line-detail source',
          path: ['lineDetailSource'],
        });
      }
    }
    if (
      value.proofType === 'other_reviewed' &&
      value.reviewerStatus !== 'reviewed' &&
      value.reviewerStatus !== 'verified'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'other_reviewed proof requires governed reviewer approval',
        path: ['reviewerStatus'],
      });
    }
  })
  .transform(stripUndefinedProperties);
export type DefenseBudgetEnactmentProofV1 = z.infer<typeof defenseBudgetEnactmentProofV1Schema>;

export const enactedLineCandidateV1Schema = z
  .object({
    candidateId: nonBlank,
    identity: budgetLineIdentityV1Schema,
    bindingStatus: z.enum(['accepted', 'candidate', 'unresolved', 'conflicting']),
    fiscalYear: z.number().int().min(1900).max(2200),
    money: moneyValueV1Schema,
    sourceDocumentId: nonBlank,
    sourceSha256: sha256Schema,
    evidenceIds: z.array(nonBlank).min(1),
    division: nonBlank.optional(),
    title: nonBlank.optional(),
    section: nonBlank.optional(),
  })
  .strict();
export type EnactedLineCandidateV1 = z.infer<typeof enactedLineCandidateV1Schema>;

export interface EnactedComparableV1 {
  identity: BudgetLineIdentityV1;
  fiscalYear: number;
  money: MoneyValueV1;
}
