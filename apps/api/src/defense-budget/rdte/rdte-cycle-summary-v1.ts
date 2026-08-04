/**
 * rdte-cycle-summary-v1 — coverage summary types and recomputation for an
 * RDT&E cycle.
 *
 * Pure module. Recomputes coverage entries from bundle inputs; never trusts
 * a stored summary without recomputation.
 */
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
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

/** Coverage numerator/denominator for one category across the cycle. */
export interface CategoryCoverageInput {
  category: RdteRequiredCategoryV1;
  /** Keys that should be covered (e.g. PE codes, project keys). */
  expectedKeys: readonly string[];
  /** Keys actually covered by a verified assertion. */
  coveredKeys: readonly string[];
  /** Whether the category is applicable for this cycle/document set. */
  applicable: boolean;
}

/** Recompute one coverage entry deterministically. */
export function computeCoverageEntry(input: CategoryCoverageInput): RdteCycleCoverageEntryV1 {
  const expected = [...new Set(input.expectedKeys)].sort();
  const covered = new Set(input.coveredKeys);
  const missingKeys = expected.filter((key) => !covered.has(key));
  const numerator = expected.length - missingKeys.length;
  const denominator = expected.length;

  let status: RdteCoverageStatusV1;
  if (!input.applicable) {
    status = 'not_applicable';
  } else if (denominator === 0) {
    status = 'missing';
  } else if (missingKeys.length === 0) {
    status = 'verified';
  } else if (numerator === 0) {
    status = 'missing';
  } else {
    status = 'needs_review';
  }

  return {
    category: input.category,
    status,
    numerator,
    denominator,
    missingKeys,
  };
}

/** Document-level presence status for the cycle summary. */
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
    input.verifications.map((v) => [v.manifestDocumentKey, v] as const),
  );
  return input.sourceDocuments
    .map((doc) => {
      const verification = verificationByDoc.get(doc.manifestDocumentKey);
      return {
        manifestDocumentKey: doc.manifestDocumentKey,
        required: doc.required,
        present: true,
        verified: verification?.decision === 'VERIFICATION_PASSED',
        decision: verification?.decision ?? null,
      };
    })
    .sort((a, b) => (a.manifestDocumentKey < b.manifestDocumentKey ? -1 : 1));
}

/** Strict schema for the recomputed cycle summary report. */
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
