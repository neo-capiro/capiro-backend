/** Deterministic read-only future-canonical RDT&E projection contracts. */
import { z } from 'zod';
import { sha256Schema } from '../../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';
import {
  verificationCandidateStatusV1Schema,
  verificationDecisionV1Schema,
} from '../../verification/verification-contract-v1.js';

export const RDTE_PROJECTION_PLAN_SCHEMA_VERSION = 'rdte_canonical_projection_plan_v1' as const;

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: 'must be nonblank',
});
const fiscalYear = z.number().int().min(1900).max(2200);

export const RDTE_PROJECTION_TARGET_V1_VALUES = [
  'ProgramElement',
  'ProgramElementYear',
  'ProgramElementBudgetPosition',
  'ProgramElementProject',
  'ProgramElementProjectBudgetPosition',
  'ProgramElementPerformer',
  'ProgramElementMilestone',
  'ProgramElementMilestoneSchedulePeriod',
  'ProgramElementSource',
] as const;
export const rdteProjectionTargetV1Schema = z.enum(RDTE_PROJECTION_TARGET_V1_VALUES);
export type RdteProjectionTargetV1 = z.infer<typeof rdteProjectionTargetV1Schema>;

export const RDTE_PROJECTION_OPERATION_V1_VALUES = [
  'insert',
  'update',
  'no_op',
  'conflict',
] as const;
export const rdteProjectionOperationV1Schema = z.enum(RDTE_PROJECTION_OPERATION_V1_VALUES);
export type RdteProjectionOperationV1 = z.infer<typeof rdteProjectionOperationV1Schema>;

export const RDTE_PROJECTION_EXCLUSION_V1_VALUES = [
  'uncertified_cycle',
  'artifact_rejected',
  'artifact_needs_review',
  'contextual_only_value',
  'non_annual_cost_value',
  'outyear_not_request',
  'duplicate_conflict',
  'unsupported_role_claim',
  'unresolved_evidence',
  'not_projection_eligible',
] as const;
export const rdteProjectionExclusionReasonV1Schema = z.enum(
  RDTE_PROJECTION_EXCLUSION_V1_VALUES,
);
export type RdteProjectionExclusionReasonV1 = z.infer<
  typeof rdteProjectionExclusionReasonV1Schema
>;

const candidateBaseShape = {
  candidateId: nonBlank,
  target: rdteProjectionTargetV1Schema,
  naturalKey: nonBlank,
  operation: rdteProjectionOperationV1Schema,
  reason: z.string(),
  artifactId: nonBlank,
  artifactContentSha256: sha256Schema,
  verificationCandidateId: nonBlank,
  verificationRunId: nonBlank,
  /** Compatibility alias equal to verificationRunId. */
  verificationDecisionId: nonBlank,
  sourceDocumentKey: nonBlank,
  sourcePdfSha256: sha256Schema,
  assertionIds: z.array(nonBlank),
  evidenceIds: z.array(nonBlank),
  values: z.record(z.union([z.string(), z.number().int(), z.boolean(), z.null()])),
  exclusionReason: rdteProjectionExclusionReasonV1Schema.optional(),
};

/**
 * Intermediate pure-mapper candidate. The production boundary must enrich and
 * validate the exact Phase 2 fields with proofBoundRdteProjectionCandidateV1Schema.
 */
export const rdteProjectionCandidateV1Schema = z
  .object({
    ...candidateBaseShape,
    verificationDecision: verificationDecisionV1Schema.optional(),
    verificationStatus: verificationCandidateStatusV1Schema.optional(),
    verificationPolicySha256: sha256Schema.optional(),
    sourceDocumentId: nonBlank.optional(),
  })
  .strict();
export type RdteProjectionCandidateV1 = z.infer<typeof rdteProjectionCandidateV1Schema>;

/** Final production candidate; every trusted Phase 2 field is mandatory. */
export const proofBoundRdteProjectionCandidateV1Schema = z
  .object({
    ...candidateBaseShape,
    verificationDecision: verificationDecisionV1Schema,
    verificationStatus: verificationCandidateStatusV1Schema,
    verificationPolicySha256: sha256Schema,
    sourceDocumentId: nonBlank,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verificationDecisionId !== value.verificationRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationDecisionId'],
        message: 'compatibility decision ID must equal verificationRunId',
      });
    }
    const expectedStatus =
      value.verificationDecision === 'PASS'
        ? 'VERIFICATION_PASSED'
        : value.verificationDecision === 'REJECT'
          ? 'REJECTED'
          : value.verificationStatus === 'REVIEW_ACCEPTED'
            ? 'REVIEW_ACCEPTED'
            : 'NEEDS_REVIEW';
    if (value.verificationStatus !== expectedStatus) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['verificationStatus'],
        message: `verification decision ${value.verificationDecision} is inconsistent with ${value.verificationStatus}`,
      });
    }
  });
export type ProofBoundRdteProjectionCandidateV1 = z.infer<
  typeof proofBoundRdteProjectionCandidateV1Schema
>;

export const rdteProjectionDiffSummaryV1Schema = z
  .object({
    target: rdteProjectionTargetV1Schema,
    insertCount: z.number().int().nonnegative(),
    updateCount: z.number().int().nonnegative(),
    noOpCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  })
  .strict();
export type RdteProjectionDiffSummaryV1 = z.infer<typeof rdteProjectionDiffSummaryV1Schema>;

export const rdteProjectionExclusionV1Schema = z
  .object({
    artifactId: nonBlank,
    assertionId: nonBlank.optional(),
    reason: rdteProjectionExclusionReasonV1Schema,
    message: z.string(),
  })
  .strict();
export type RdteProjectionExclusionV1 = z.infer<typeof rdteProjectionExclusionV1Schema>;

const planBaseShape = {
  schemaVersion: z.literal(RDTE_PROJECTION_PLAN_SCHEMA_VERSION),
  cycleId: nonBlank,
  cycleBundleContentSha256: sha256Schema,
  cycleCertification: z.literal('CERTIFIED_RDTE_READY_FOR_PROJECTION'),
  fiscalYear,
  positionCycle: nonBlank,
  exclusions: z.array(rdteProjectionExclusionV1Schema),
  diffSummary: z.array(rdteProjectionDiffSummaryV1Schema),
  diffedAgainstCanonicalRows: z.boolean(),
  contentSha256: sha256Schema,
};

/** Intermediate mapper plan. */
export const rdteCanonicalProjectionPlanV1Schema = z
  .object({
    ...planBaseShape,
    candidates: z.array(rdteProjectionCandidateV1Schema),
  })
  .strict();
export type RdteCanonicalProjectionPlanV1 = z.infer<
  typeof rdteCanonicalProjectionPlanV1Schema
>;

/** Final production plan returned by the proof-bound wrapper. */
export const proofBoundRdteCanonicalProjectionPlanV1Schema = z
  .object({
    ...planBaseShape,
    candidates: z.array(proofBoundRdteProjectionCandidateV1Schema),
  })
  .strict();
export type ProofBoundRdteCanonicalProjectionPlanV1 = z.infer<
  typeof proofBoundRdteCanonicalProjectionPlanV1Schema
>;

export function computeProjectionPlanContentSha256(
  plan: Omit<RdteCanonicalProjectionPlanV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(plan as unknown as JsonValue);
}

export function rdteProjectionCandidateId(identity: JsonValue): string {
  return `rdte_proj_${sha256CanonicalJson(identity)}`;
}
