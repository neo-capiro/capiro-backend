/**
 * non-rdte-cycle-bundle-v1 — the deterministic non-RDT&E cycle bundle contract.
 *
 * One bundle per annual non-RDT&E cycle (procurement, O&M, MILCON). It
 * references Phase 1 artifact IDs and Phase 2 verification IDs by content
 * SHA; it never copies trusted proof claims. No timestamps participate in
 * deterministic IDs or content hashes.
 *
 * Workstream N (Phase 5 plan §14). Pure module: no NestJS, Prisma, AWS,
 * parser, or writer dependency.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

export const NON_RDTE_CYCLE_BUNDLE_SCHEMA_VERSION = 'non_rdte_cycle_bundle_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

const fiscalYear = z.number().int().min(1900).max(2200);

/* ------------------------------------------------------------------ */
/* Family vocabulary                                                    */
/* ------------------------------------------------------------------ */

export const NON_RDTE_FAMILY_V1_VALUES = ['procurement', 'om', 'milcon'] as const;
export const nonRdteFamilyV1Schema = z.enum(NON_RDTE_FAMILY_V1_VALUES);
export type NonRdteFamilyV1 = z.infer<typeof nonRdteFamilyV1Schema>;

/* ------------------------------------------------------------------ */
/* Source-document entry                                               */
/* ------------------------------------------------------------------ */

export const nonRdteCycleSourceDocumentV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    family: nonRdteFamilyV1Schema,
    exhibit: nonBlank,
    required: z.boolean(),
    sourcePdfSha256: sha256Schema,
    sourceLocator: nonBlank,
    pageCount: z.number().int().positive().optional(),
  })
  .strict();
export type NonRdteCycleSourceDocumentV1 = z.infer<typeof nonRdteCycleSourceDocumentV1Schema>;

/* ------------------------------------------------------------------ */
/* Artifact reference (Phase 1)                                        */
/* ------------------------------------------------------------------ */

export const nonRdteCycleArtifactRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
  })
  .strict();
export type NonRdteCycleArtifactRefV1 = z.infer<typeof nonRdteCycleArtifactRefV1Schema>;

/* ------------------------------------------------------------------ */
/* Verification reference (Phase 2)                                    */
/* ------------------------------------------------------------------ */

export const NON_RDTE_VERIFICATION_DECISION_V1_VALUES = [
  'VERIFICATION_PASSED',
  'NEEDS_REVIEW',
  'REJECTED',
] as const;
export const nonRdteVerificationDecisionV1Schema = z.enum(NON_RDTE_VERIFICATION_DECISION_V1_VALUES);
export type NonRdteVerificationDecisionV1 = z.infer<typeof nonRdteVerificationDecisionV1Schema>;

export const nonRdteCycleVerificationRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    artifactId: nonBlank,
    verificationCandidateId: nonBlank,
    verificationRunId: nonBlank,
    decision: nonRdteVerificationDecisionV1Schema,
    decisionId: nonBlank,
  })
  .strict();
export type NonRdteCycleVerificationRefV1 = z.infer<typeof nonRdteCycleVerificationRefV1Schema>;

/* ------------------------------------------------------------------ */
/* Coverage summary                                                    */
/* ------------------------------------------------------------------ */

export const NON_RDTE_COVERAGE_STATUS_V1_VALUES = [
  'complete',
  'partial',
  'missing',
  'not_applicable',
] as const;
export const nonRdteCoverageStatusV1Schema = z.enum(NON_RDTE_COVERAGE_STATUS_V1_VALUES);
export type NonRdteCoverageStatusV1 = z.infer<typeof nonRdteCoverageStatusV1Schema>;

export const nonRdteCycleCoverageEntryV1Schema = z
  .object({
    category: nonBlank,
    status: nonRdteCoverageStatusV1Schema,
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    missingKeys: z.array(nonBlank),
  })
  .strict();
export type NonRdteCycleCoverageEntryV1 = z.infer<typeof nonRdteCycleCoverageEntryV1Schema>;

/* ------------------------------------------------------------------ */
/* Certification                                                       */
/* ------------------------------------------------------------------ */

export const NON_RDTE_CYCLE_CERTIFICATION_V1_VALUES = [
  'CERTIFIED_NON_RDTE_READY_FOR_PROJECTION',
  'NEEDS_REVIEW',
  'REJECTED',
  'INCOMPLETE',
] as const;
export const nonRdteCycleCertificationV1Schema = z.enum(NON_RDTE_CYCLE_CERTIFICATION_V1_VALUES);
export type NonRdteCycleCertificationV1 = z.infer<typeof nonRdteCycleCertificationV1Schema>;

export const nonRdteCycleFindingV1Schema = z
  .object({
    findingId: nonBlank,
    severity: z.enum(['blocking', 'review', 'info']),
    code: nonBlank,
    message: z.string(),
    evidenceIds: z.array(nonBlank),
  })
  .strict();
export type NonRdteCycleFindingV1 = z.infer<typeof nonRdteCycleFindingV1Schema>;

/* ------------------------------------------------------------------ */
/* Bundle envelope                                                     */
/* ------------------------------------------------------------------ */

export const nonRdteCycleBundleV1Schema = z
  .object({
    schemaVersion: z.literal(NON_RDTE_CYCLE_BUNDLE_SCHEMA_VERSION),
    cycleId: nonBlank,
    fiscalYear,
    family: nonRdteFamilyV1Schema,
    manifestContentSha256: sha256Schema,
    sourceDocuments: z.array(nonRdteCycleSourceDocumentV1Schema),
    artifacts: z.array(nonRdteCycleArtifactRefV1Schema),
    verifications: z.array(nonRdteCycleVerificationRefV1Schema),
    coverage: z.array(nonRdteCycleCoverageEntryV1Schema),
    projectionPlanContentSha256: sha256Schema.optional(),
    certification: nonRdteCycleCertificationV1Schema,
    blockingFindings: z.array(nonRdteCycleFindingV1Schema),
    nonBlockingFindings: z.array(nonRdteCycleFindingV1Schema),
    contentSha256: sha256Schema,
  })
  .strict();
export type NonRdteCycleBundleV1 = z.infer<typeof nonRdteCycleBundleV1Schema>;

/* ------------------------------------------------------------------ */
/* Deterministic ID + content hash                                     */
/* ------------------------------------------------------------------ */

export function nonRdteCycleBundleId(identity: JsonValue): string {
  return `non_rdte_cycle_${sha256CanonicalJson(identity)}`;
}

/** Compute the deterministic content SHA for a bundle (excludes contentSha256). */
export function computeNonRdteCycleBundleContentSha256(
  bundle: Omit<NonRdteCycleBundleV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(bundle as unknown as JsonValue);
}
