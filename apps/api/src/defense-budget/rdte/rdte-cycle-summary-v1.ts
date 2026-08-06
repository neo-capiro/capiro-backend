/** Coverage and document-presence summary for an RDT&E cycle. */
import { z } from 'zod';
import { rdteCoverageStatusV1Schema, type RdteCoverageStatusV1 } from './rdte-column-role-v1.js';
import type {
  RdteCycleCoverageEntryV1,
  RdteCycleSourceDocumentV1,
  RdteCycleVerificationRefV1,
} from './rdte-cycle-bundle-v1.js';

export const RDTE_REQUIRED_CATEGORY_V1_VALUES = [
  'identity',
  'funding',
  'narrative',
  'projects',
  'project_funding',
  'performers',
  'milestones',
  'relationships',
] as const;
export const rdteRequiredCategoryV1Schema = z.enum(RDTE_REQUIRED_CATEGORY_V1_VALUES);
export type RdteRequiredCategoryV1 = z.infer<typeof rdteRequiredCategoryV1Schema>;

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must be nonblank',
  });

export interface CategoryCoverageInput {
  category: RdteRequiredCategoryV1;
  expectedKeys: readonly string[];
  coveredKeys: readonly string[];
  applicable: boolean;
}

export function computeCoverageEntry(input: CategoryCoverageInput): RdteCycleCoverageEntryV1 {
  const expected = [...new Set(input.expectedKeys)].sort();
  const covered = new Set(input.coveredKeys);
  const missingKeys = expected.filter((key) => !covered.has(key));
  const numerator = expected.length - missingKeys.length;
  const denominator = expected.length;

  let status: RdteCoverageStatusV1;
  if (!input.applicable) status = 'not_applicable';
  else if (denominator === 0 || numerator === 0) status = 'missing';
  else if (missingKeys.length === 0) status = 'verified';
  else status = 'needs_review';

  return { category: input.category, status, numerator, denominator, missingKeys };
}

export interface DocumentPresenceInput {
  sourceDocuments: readonly RdteCycleSourceDocumentV1[];
  verifications: readonly RdteCycleVerificationRefV1[];
}

export interface DocumentPresenceEntry {
  manifestDocumentKey: string;
  required: boolean;
  present: boolean;
  verified: boolean;
  decision: string | null;
}

export function computeDocumentPresence(input: DocumentPresenceInput): DocumentPresenceEntry[] {
  const verificationByDoc = new Map(
    input.verifications.map((value) => [value.manifestDocumentKey, value] as const),
  );
  return input.sourceDocuments
    .map((document) => {
      const verification = verificationByDoc.get(document.manifestDocumentKey);
      const verified =
        verification !== undefined &&
        ((verification.phase2Decision === 'PASS' &&
          verification.status === 'VERIFICATION_PASSED') ||
          (verification.phase2Decision === 'REVIEW' && verification.status === 'REVIEW_ACCEPTED'));
      return {
        manifestDocumentKey: document.manifestDocumentKey,
        required: document.required,
        present: true,
        verified,
        decision: verification ? `${verification.phase2Decision}/${verification.status}` : null,
      };
    })
    .sort((left, right) => left.manifestDocumentKey.localeCompare(right.manifestDocumentKey));
}

export const rdteCycleSummaryV1Schema = z
  .object({
    cycleId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    coverage: z.array(
      z
        .object({
          category: nonBlank,
          status: rdteCoverageStatusV1Schema,
          numerator: z.number().int().nonnegative(),
          denominator: z.number().int().nonnegative(),
          missingKeys: z.array(nonBlank),
        })
        .strict(),
    ),
    documentPresence: z.array(
      z
        .object({
          manifestDocumentKey: nonBlank,
          required: z.boolean(),
          present: z.boolean(),
          verified: z.boolean(),
          decision: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type RdteCycleSummaryV1 = z.infer<typeof rdteCycleSummaryV1Schema>;
