/**
 * rdte-canonical-projection-plan-v1 — the deterministic, read-only
 * future-canonical projection plan contract.
 *
 * Workstream M (Phase 4 plan §18). The plan records the exact future
 * canonical records Phase 7 will write, mapped from verified RDT&E
 * assertions of a certified cycle. It performs NO database write: the words
 * `projection`, `candidate`, and `ready` do not authorize a write, and no
 * field below is equivalent to `promotionReady`.
 *
 * Eligibility (plan §18): only assertions from a cycle certified
 * CERTIFIED_RDTE_READY_FOR_PROJECTION are projected. Excluded:
 *   - rejected artifacts;
 *   - review-pending artifacts;
 *   - contextual-only values;
 *   - cost-to-complete/total-cost values from annual funding targets;
 *   - outyear values from ProgramElementYear.request;
 *   - duplicate-conflict assertions;
 *   - unsupported role claims;
 *   - unresolved evidence.
 *
 * Pure module: no NestJS, Prisma, AWS, parser, or writer dependency.
 */
import { z } from 'zod';
import { sha256Schema } from '../../contracts/extraction-artifact-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../../contracts/canonical-json.js';

export const RDTE_PROJECTION_PLAN_SCHEMA_VERSION = 'rdte_canonical_projection_plan_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((s) => s.trim().length > 0, { message: 'must be nonblank' });

const fiscalYear = z.number().int().min(1900).max(2200);

/* ------------------------------------------------------------------ */
/* Vocabulary                                                          */
/* ------------------------------------------------------------------ */

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
export const rdteProjectionExclusionReasonV1Schema = z.enum(RDTE_PROJECTION_EXCLUSION_V1_VALUES);
export type RdteProjectionExclusionReasonV1 = z.infer<
  typeof rdteProjectionExclusionReasonV1Schema
>;

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
export const rdteProjectionCandidateV1Schema = z
  .object({
    candidateId: nonBlank,
    target: rdteProjectionTargetV1Schema,
    naturalKey: nonBlank,
    operation: rdteProjectionOperationV1Schema,
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
    exclusionReason: rdteProjectionExclusionReasonV1Schema.optional(),
  })
  .strict();
export type RdteProjectionCandidateV1 = z.infer<typeof rdteProjectionCandidateV1Schema>;

/* ------------------------------------------------------------------ */
/* Diff summary                                                        */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Exclusion ledger                                                    */
/* ------------------------------------------------------------------ */

export const rdteProjectionExclusionV1Schema = z
  .object({
    artifactId: nonBlank,
    assertionId: nonBlank.optional(),
    reason: rdteProjectionExclusionReasonV1Schema,
    message: z.string(),
  })
  .strict();
export type RdteProjectionExclusionV1 = z.infer<typeof rdteProjectionExclusionV1Schema>;

/* ------------------------------------------------------------------ */
/* Plan envelope                                                       */
/* ------------------------------------------------------------------ */

export const rdteCanonicalProjectionPlanV1Schema = z
  .object({
    schemaVersion: z.literal(RDTE_PROJECTION_PLAN_SCHEMA_VERSION),
    cycleId: nonBlank,
    cycleBundleContentSha256: sha256Schema,
    cycleCertification: z.literal('CERTIFIED_RDTE_READY_FOR_PROJECTION'),
    fiscalYear,
    /** The PB cycle these positions belong to, e.g. `pb_fy2027`. */
    positionCycle: nonBlank,
    candidates: z.array(rdteProjectionCandidateV1Schema),
    exclusions: z.array(rdteProjectionExclusionV1Schema),
    diffSummary: z.array(rdteProjectionDiffSummaryV1Schema),
    /** True only when an explicit read-only diff against canonical rows ran. */
    diffedAgainstCanonicalRows: z.boolean(),
    contentSha256: sha256Schema,
  })
  .strict();
export type RdteCanonicalProjectionPlanV1 = z.infer<typeof rdteCanonicalProjectionPlanV1Schema>;

/* ------------------------------------------------------------------ */
/* Deterministic content hash                                          */
/* ------------------------------------------------------------------ */

/** Compute the deterministic content SHA for a plan (excludes contentSha256). */
export function computeProjectionPlanContentSha256(
  plan: Omit<RdteCanonicalProjectionPlanV1, 'contentSha256'>,
): string {
  return sha256CanonicalJson(plan as unknown as JsonValue);
}

/* ------------------------------------------------------------------ */
/* Candidate ID (deterministic from natural identity)                  */
/* ------------------------------------------------------------------ */

export function rdteProjectionCandidateId(identity: JsonValue): string {
  return `rdte_proj_${sha256CanonicalJson(identity)}`;
}
