/**
 * rdte-cycle-bundle-v1 — deterministic RDT&E cycle bundle contract.
 *
 * Exact Phase 2 fields are authoritative. Compatibility aliases exist only so
 * the pre-closeout projection planner can be incrementally migrated; the
 * certifier never uses those aliases to establish trust.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import {
  defenseBudgetVerificationResultV1Schema,
  verificationCandidateStatusV1Schema,
  verificationDecisionV1Schema,
  type DefenseBudgetVerificationResultV1,
} from '../verification/verification-contract-v1.js';
import { rdteCoverageStatusV1Schema, rdteExhibitRoleV1Schema } from './rdte-column-role-v1.js';

export const RDTE_CYCLE_BUNDLE_SCHEMA_VERSION = 'rdte_cycle_bundle_v1' as const;

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const fiscalYear = z.number().int().min(1900).max(2200);

export const rdteCycleSourceDocumentV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    sourceDocumentId: nonBlank,
    exhibitRole: rdteExhibitRoleV1Schema,
    required: z.boolean(),
    sourcePdfSha256: sha256Schema,
    sourceLocator: nonBlank,
    pageCount: z.number().int().positive().optional(),
    parserRunIds: z.array(nonBlank),
    unresolvedPages: z.array(z.number().int().positive()),
  })
  .strict();
export type RdteCycleSourceDocumentV1 = z.infer<typeof rdteCycleSourceDocumentV1Schema>;

export const rdteCycleArtifactRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
    artifactByteSha256: sha256Schema,
  })
  .strict();
export type RdteCycleArtifactRefV1 = z.infer<typeof rdteCycleArtifactRefV1Schema>;

export const rdteCycleVerificationRefV1Schema = z
  .object({
    manifestDocumentKey: nonBlank,
    manifestContentSha256: sha256Schema,
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
    artifactByteSha256: sha256Schema,
    candidateId: nonBlank,
    verificationRunId: nonBlank,
    policySha256: sha256Schema,
    sourceDocumentId: nonBlank,
    sourcePdfSha256: sha256Schema,
    phase2Decision: verificationDecisionV1Schema,
    status: verificationCandidateStatusV1Schema,
    acceptedAssertionIds: z.array(nonBlank),
    rejectedAssertionIds: z.array(nonBlank),
    verificationCandidateId: nonBlank,
    decision: verificationCandidateStatusV1Schema,
    decisionId: nonBlank,
  })
  .strict()
  .superRefine((value, ctx) => {
    const expectedStatus =
      value.phase2Decision === 'PASS'
        ? 'VERIFICATION_PASSED'
        : value.phase2Decision === 'REJECT'
          ? 'REJECTED'
          : value.status === 'REVIEW_ACCEPTED'
            ? 'REVIEW_ACCEPTED'
            : 'NEEDS_REVIEW';
    if (value.status !== expectedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['status'],
        message: `decision ${value.phase2Decision} is inconsistent with status ${value.status}`,
      });
    }
    if (value.decision !== value.status) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: 'compatibility decision alias must equal status',
      });
    }
    if (value.verificationCandidateId !== value.candidateId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationCandidateId'],
        message: 'candidate compatibility alias must equal candidateId',
      });
    }
    if (value.decisionId !== value.verificationRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionId'],
        message: 'decision compatibility alias must equal verificationRunId',
      });
    }
  });
export type RdteCycleVerificationRefV1 = z.infer<typeof rdteCycleVerificationRefV1Schema>;

/**
 * Convert a Phase 2 result into a cycle reference without relabeling its
 * canonical content SHA as a serialized-byte SHA. The exact byte SHA is used
 * when the caller supplies it. Older callers that already passed the byte hash
 * into Phase 2's expectedExtractionArtifactSha256 guard use the content SHA as
 * an explicit sentinel; the certifier does not re-compare that sentinel.
 */
export function rdteVerificationRefFromResult(input: {
  result: DefenseBudgetVerificationResultV1;
  artifactContentSha256: string;
  artifactByteSha256?: string;
}): RdteCycleVerificationRefV1 {
  const result = defenseBudgetVerificationResultV1Schema.parse(input.result);
  const artifactContentSha256 = sha256Schema.parse(input.artifactContentSha256);
  const artifactByteSha256 = sha256Schema.parse(
    input.artifactByteSha256 ?? artifactContentSha256,
  );
  if (result.extractionArtifactSha256 !== artifactContentSha256) {
    throw new Error(
      `Phase 2 result content SHA ${result.extractionArtifactSha256} does not match artifact ${artifactContentSha256}`,
    );
  }
  return rdteCycleVerificationRefV1Schema.parse({
    manifestDocumentKey: result.manifestDocumentKey,
    manifestContentSha256: result.manifestContentSha256,
    artifactId: result.extractionArtifactId,
    artifactContentSha256,
    artifactByteSha256,
    candidateId: result.candidateId,
    verificationRunId: result.verificationRunId,
    policySha256: result.policySha256,
    sourceDocumentId: result.sourceDocumentId,
    sourcePdfSha256: result.sourcePdfSha256,
    phase2Decision: result.decision,
    status: result.status,
    acceptedAssertionIds: result.acceptedAssertionIds,
    rejectedAssertionIds: result.rejectedAssertionIds,
    verificationCandidateId: result.candidateId,
    decision: result.status,
    decisionId: result.verificationRunId,
  });
}

export const COMPARISON_RESULT_V1_VALUES = ['pass', 'fail', 'review', 'not_applicable'] as const;
export const comparisonResultV1Schema = z.enum(COMPARISON_RESULT_V1_VALUES);
export type ComparisonResultV1 = z.infer<typeof comparisonResultV1Schema>;

export const rdteCycleComparisonV1Schema = z
  .object({
    comparisonId: nonBlank,
    comparisonKind: nonBlank,
    peCode: nonBlank,
    fiscalYear,
    columnRole: nonBlank,
    leftArtifactId: nonBlank,
    rightArtifactId: nonBlank,
    leftAssertionIds: z.array(nonBlank),
    rightAssertionIds: z.array(nonBlank),
    result: comparisonResultV1Schema,
    toleranceMillions: z.string().optional(),
    evidenceIds: z.array(nonBlank),
    message: z.string().optional(),
  })
  .strict();
export type RdteCycleComparisonV1 = z.infer<typeof rdteCycleComparisonV1Schema>;

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

export function rdteCycleBundleId(identity: JsonValue): string {
  return `rdte_cycle_${sha256CanonicalJson(identity)}`;
}

export function computeRdteCycleBundleContentSha256(
  bundle: Omit<RdteCycleBundleV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(bundle as unknown as JsonValue);
}
