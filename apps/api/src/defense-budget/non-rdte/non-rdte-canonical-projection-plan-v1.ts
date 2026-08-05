/**
 * non-rdte-canonical-projection-plan-v1 — the deterministic, read-only
 * future-canonical projection plan contract for non-RDT&E families.
 *
 * Workstream M (Phase 5 plan §18). The plan records the exact future
 * canonical records Phase 7 will write, mapped from verified assertions of
 * a certified non-RDT&E cycle (procurement, O&M, MILCON). It performs NO
 * database write: the words `projection`, `candidate`, and `ready` do not
 * authorize a write, and no field below is equivalent to `promotionReady`.
 *
 * Eligibility (plan §18): only assertions from a cycle certified
 * CERTIFIED_NON_RDTE_READY_FOR_PROJECTION are projected. Excluded:
 *   - rejected artifacts;
 *   - review-pending artifacts (without allowed reviewed acceptance);
 *   - contextual-only values;
 *   - OCR-derived money that requires review (ocr_review_required);
 *   - duplicate-conflict assertions;
 *   - unsupported role claims;
 *   - unresolved evidence;
 *   - not-projection-eligible assertions.
 *
 * Pure module: no NestJS, Prisma, AWS, parser, or writer dependency.
 */
import { z } from 'zod';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';

export const NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION =
  'non_rdte_canonical_projection_plan_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

const fiscalYear = z.number().int().min(1900).max(2200);

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

export const NON_RDTE_PROJECTION_TARGET_V1_VALUES = [
  'ProcurementBudgetLine',
  'ProcurementBudgetLineYear',
  'ProcurementDistributionLine',
  'ProcurementDetailFact',
  'OmSag',
  'OmSagYear',
  'OmDetailFact',
  'MilconProject',
  'MilconProjectYear',
  'MilconDetailFact',
  'BudgetLineSourceObservation',
  'BudgetLineRelationship',
] as const;
export const nonRdteProjectionTargetV1Schema = z.enum(NON_RDTE_PROJECTION_TARGET_V1_VALUES);
export type NonRdteProjectionTargetV1 = z.infer<typeof nonRdteProjectionTargetV1Schema>;

export const NON_RDTE_PROJECTION_OPERATION_V1_VALUES = [
  'insert',
  'update',
  'no_op',
  'conflict',
] as const;
export const nonRdteProjectionOperationV1Schema = z.enum(NON_RDTE_PROJECTION_OPERATION_V1_VALUES);
export type NonRdteProjectionOperationV1 = z.infer<typeof nonRdteProjectionOperationV1Schema>;

export const NON_RDTE_PROJECTION_EXCLUSION_V1_VALUES = [
  'uncertified_cycle',
  'artifact_rejected',
  'artifact_needs_review',
  'contextual_only_value',
  'duplicate_conflict',
  'unsupported_role_claim',
  'unresolved_evidence',
  'not_projection_eligible',
  'ocr_review_required',
] as const;
export const nonRdteProjectionExclusionReasonV1Schema = z.enum(
  NON_RDTE_PROJECTION_EXCLUSION_V1_VALUES,
);
export type NonRdteProjectionExclusionReasonV1 = z.infer<
  typeof nonRdteProjectionExclusionReasonV1Schema
>;

export const NON_RDTE_FAMILY_V1_VALUES = ['procurement', 'om', 'milcon'] as const;
export const nonRdteFamilyProjectionV1Schema = z.enum(NON_RDTE_FAMILY_V1_VALUES);
export type NonRdteProjectionFamilyV1 = z.infer<typeof nonRdteFamilyProjectionV1Schema>;

/* ------------------------------------------------------------------ */
/* Candidate                                                           */
/* ------------------------------------------------------------------ */

/**
 * One future canonical record candidate. Carries full provenance back to the
 * extraction artifact, Phase 2 verification decision, source document, and
 * evidence. `values` are exact canonical decimal strings (never floats).
 *
 * When the candidate is excluded (`operation: 'conflict'` with
 * `exclusionReason`, or a record-level exclusion), `exclusionReason` states
 * why — the candidate still carries its exact source values.
 */
export const nonRdteProjectionCandidateV1Schema = z
  .object({
    candidateId: nonBlank,
    target: nonRdteProjectionTargetV1Schema,
    naturalKey: nonBlank,
    operation: nonRdteProjectionOperationV1Schema,
    reason: z.string(),
    /* Provenance. */
    artifactId: nonBlank,
    artifactContentSha256: sha256Schema,
    verificationCandidateId: nonBlank,
    verificationRunId: nonBlank,
    verificationDecisionId: nonBlank,
    sourceDocumentKey: nonBlank,
    sourcePdfSha256: sha256Schema,
    assertionIds: z.array(nonBlank),
    evidenceIds: z.array(nonBlank),
    /* Exact future values (canonical decimal strings where monetary).
     * Required: every candidate carries its exact values; excluded records
     * are represented in the exclusions ledger, never as silent drops. */
    values: z.record(z.union([z.string(), z.number().int(), z.boolean(), z.null()])),
    /* Context-only exclusion reason when excluded. */
    exclusionReason: nonRdteProjectionExclusionReasonV1Schema.optional(),
  })
  .strict();
export type NonRdteProjectionCandidateV1 = z.infer<typeof nonRdteProjectionCandidateV1Schema>;

/* ------------------------------------------------------------------ */
/* Diff summary                                                        */
/* ------------------------------------------------------------------ */

export const nonRdteProjectionDiffSummaryV1Schema = z
  .object({
    target: nonRdteProjectionTargetV1Schema,
    insertCount: z.number().int().nonnegative(),
    updateCount: z.number().int().nonnegative(),
    noOpCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
  })
  .strict();
export type NonRdteProjectionDiffSummaryV1 = z.infer<typeof nonRdteProjectionDiffSummaryV1Schema>;

/* ------------------------------------------------------------------ */
/* Exclusion ledger                                                    */
/* ------------------------------------------------------------------ */

export const nonRdteProjectionExclusionV1Schema = z
  .object({
    artifactId: nonBlank,
    assertionId: nonBlank.optional(),
    reason: nonRdteProjectionExclusionReasonV1Schema,
    message: z.string(),
  })
  .strict();
export type NonRdteProjectionExclusionV1 = z.infer<typeof nonRdteProjectionExclusionV1Schema>;

/* ------------------------------------------------------------------ */
/* Plan envelope                                                       */
/* ------------------------------------------------------------------ */

export const nonRdteCanonicalProjectionPlanV1Schema = z
  .object({
    schemaVersion: z.literal(NON_RDTE_PROJECTION_PLAN_SCHEMA_VERSION),
    cycleId: nonBlank,
    cycleBundleContentSha256: sha256Schema,
    cycleCertification: z.literal('CERTIFIED_NON_RDTE_READY_FOR_PROJECTION'),
    fiscalYear,
    family: nonRdteFamilyProjectionV1Schema,
    /** The PB cycle these positions belong to, e.g. `pb_fy2027`. */
    positionCycle: nonBlank,
    candidates: z.array(nonRdteProjectionCandidateV1Schema),
    exclusions: z.array(nonRdteProjectionExclusionV1Schema),
    diffSummary: z.array(nonRdteProjectionDiffSummaryV1Schema),
    /** True only when an explicit read-only diff against canonical rows ran. */
    diffedAgainstCanonicalRows: z.boolean(),
    contentSha256: sha256Schema,
  })
  .strict();
export type NonRdteCanonicalProjectionPlanV1 = z.infer<
  typeof nonRdteCanonicalProjectionPlanV1Schema
>;

/* ------------------------------------------------------------------ */
/* Deterministic content hash                                          */
/* ------------------------------------------------------------------ */

/** Compute the deterministic content SHA for a plan (excludes contentSha256). */
export function computeNonRdteProjectionPlanContentSha256(
  plan: Omit<NonRdteCanonicalProjectionPlanV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(plan as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* Candidate ID (deterministic from natural identity)                  */
/* ------------------------------------------------------------------ */

export function nonRdteProjectionCandidateId(identity: JsonValue): string {
  return `non_rdte_proj_${sha256CanonicalJson(identity)}`;
}
