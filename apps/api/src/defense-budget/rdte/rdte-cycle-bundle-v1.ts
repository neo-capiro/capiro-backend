/**
 * rdte-cycle-bundle-v1 — the deterministic RDT&E cycle bundle contract.
 *
 * One bundle per annual RDT&E cycle. It references Phase 1 artifact IDs and
 * Phase 2 verification IDs by content SHA; it never copies trusted proof
 * claims. No timestamps participate in deterministic IDs or content hashes.
 *
 * Pure module: no NestJS, Prisma, AWS, parser, or writer dependency.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import { rdteCoverageStatusV1Schema, rdteExhibitRoleV1Schema } from './rdte-column-role-v1.js';

export const RDTE_CYCLE_BUNDLE_SCHEMA_VERSION = 'rdte_cycle_bundle_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

const fiscalYear = z.number().int().min(1900).max(2200);

/* ------------------------------------------------------------------ */
/* Source-document entry                                               */
/* ------------------------------------------------------------------ */

export const rdteCycleSourceDocumentV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    exhibitRole: rdteExhibitRoleV1Schema,
    required: z.boolean(),
    sourcePdfSha256: sha256Schema,
    sourceLocator: nonBlank,
    pageCount: z.number().int().positive().optional(),
  })
  .strict();
export type RdteCycleSourceDocumentV1 = z.infer<typeof rdteCycleSourceDocumentV1Schema>;

/* ------------------------------------------------------------------ */
/* Artifact reference (Phase 1)                                        */
/* ------------------------------------------------------------------ */

export const rdteCycleArtifactRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
  })
  .strict();
export type RdteCycleArtifactRefV1 = z.infer<typeof rdteCycleArtifactRefV1Schema>;

/* ------------------------------------------------------------------ */
/* Verification reference (Phase 2)                                    */
/* ------------------------------------------------------------------ */

export const VERIFICATION_DECISION_V1_VALUES = [
  'VERIFICATION_PASSED',
  'NEEDS_REVIEW',
  'REJECTED',
] as const;
export const verificationDecisionV1Schema = z.enum(VERIFICATION_DECISION_V1_VALUES);
export type VerificationDecisionV1 = z.infer<typeof verificationDecisionV1Schema>;

export const rdteCycleVerificationRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    artifactId: nonBlank,
    verificationCandidateId: nonBlank,
    verificationRunId: nonBlank,
    decision: verificationDecisionV1Schema,
    decisionId: nonBlank,
  })
  .strict();
export type RdteCycleVerificationRefV1 = z.infer<typeof rdteCycleVerificationRefV1Schema>;

/* ------------------------------------------------------------------ */
/* Cross-exhibit comparison                                            */
/* ------------------------------------------------------------------ */

export const COMPARISON_RESULT_V1_VALUES = ['pass', 'fail', 'review', 'not_applicable'] as const;
export const comparisonResultV1Schema = z.enum(COMPARISON_RESULT_V1_VALUES);
export type ComparisonResultV1 = z.infer<typeof comparisonResultV1Schema>;

export const rdteCycleComparisonV1Schema = z
  .object({
    comparisonId: nonBlank,
    comparisonKind: nonBlank,
    leftArtifactId: nonBlank,
    rightArtifactId: nonBlank,
    result: comparisonResultV1Schema,
    evidenceIds: z.array(nonBlank),
    message: z.string().optional(),
  })
  .strict();
export type RdteCycleComparisonV1 = z.infer<typeof rdteCycleComparisonV1Schema>;

/* ------------------------------------------------------------------ */
/* Coverage summary                                                    */
/* ------------------------------------------------------------------ */

export const rdteCycleCoverageEntryV1Schema = z
  .object({
    category: nonBlank,
    status: rdteCoverageStatusV1Schema,
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    missingKeys: z.array(nonBlank),
  })
  .strict();
export type RdteCycleCoverageEntryV1 = z.infer<typeof rdteCycleCoverageEntryV1Schema>;

/* ------------------------------------------------------------------ */
/* Certification                                                       */
/* ------------------------------------------------------------------ */

export const CYCLE_CERTIFICATION_V1_VALUES = [
  'CERTIFIED_RDTE_READY_FOR_PROJECTION',
  'NEEDS_REVIEW',
  'REJECTED',
  'INCOMPLETE',
] as const;
export const cycleCertificationV1Schema = z.enum(CYCLE_CERTIFICATION_V1_VALUES);
export type CycleCertificationV1 = z.infer<typeof cycleCertificationV1Schema>;

export const rdteCycleFindingV1Schema = z
  .object({
    findingId: nonBlank,
    severity: z.enum(['blocking', 'review', 'info']),
    code: nonBlank,
    message: z.string(),
    evidenceIds: z.array(nonBlank),
  })
  .strict();
export type RdteCycleFindingV1 = z.infer<typeof rdteCycleFindingV1Schema>;

/* ------------------------------------------------------------------ */
/* Bundle envelope                                                     */
/* ------------------------------------------------------------------ */

export const rdteCycleBundleV1Schema = z
  .object({
    schemaVersion: z.literal(RDTE_CYCLE_BUNDLE_SCHEMA_VERSION),
    cycleId: nonBlank,
    fiscalYear,
    manifestContentSha256: sha256Schema,
    sourceDocuments: z.array(rdteCycleSourceDocumentV1Schema),
    artifacts: z.array(rdteCycleArtifactRefV1Schema),
    verifications: z.array(rdteCycleVerificationRefV1Schema),
    comparisons: z.array(rdteCycleComparisonV1Schema),
    coverage: z.array(rdteCycleCoverageEntryV1Schema),
    projectionPlanContentSha256: sha256Schema.optional(),
    certification: cycleCertificationV1Schema,
    blockingFindings: z.array(rdteCycleFindingV1Schema),
    nonBlockingFindings: z.array(rdteCycleFindingV1Schema),
    contentSha256: sha256Schema,
  })
  .strict();
export type RdteCycleBundleV1 = z.infer<typeof rdteCycleBundleV1Schema>;

/* ------------------------------------------------------------------ */
/* Deterministic ID + content hash                                     */
/* ------------------------------------------------------------------ */

export function rdteCycleBundleId(identity: JsonValue): string {
  return `rdte_cycle_${sha256CanonicalJson(identity)}`;
}

/** Compute the deterministic content SHA for a bundle (excludes contentSha256). */
export function computeRdteCycleBundleContentSha256(
  bundle: Omit<RdteCycleBundleV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(bundle as unknown as JsonValue);
}
