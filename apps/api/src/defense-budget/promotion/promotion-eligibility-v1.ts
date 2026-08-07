/**
 * Phase 7 Workstream A — `defense_budget_promotion_eligibility_v1`.
 *
 * The only valid description of "these verified projections may be considered
 * for canonical promotion". It is deliberately NOT sufficient on its own: an
 * eligibility record states that the trusted inputs line up, and nothing more.
 * Promotion additionally requires a separate, independently issued
 * `defense_budget_promotion_authorization_v1` bound to this record's hash.
 *
 * Phase 2 is explicit that `VERIFICATION_PASSED` carries no canonical
 * implication and that review acceptance creates no promotion property. This
 * contract is where that boundary is made machine-checkable: it enumerates the
 * exact candidates, runs, assertions, plans, mappings, certifications, and
 * source hashes a promotion is allowed to rest on, and it refuses everything
 * else.
 *
 * Hashing is order-independent by construction — every identifier collection is
 * sorted and de-duplicated before serialization — so re-deriving eligibility
 * from the same facts in a different order yields the same hash.
 */
import { z } from 'zod';
import { sha256CanonicalJson, stripUndefinedProperties } from '../contracts/canonical-json.js';
import {
  budgetFamilyV1Schema,
  extractionMethodV1Schema,
  sha256Schema,
  type ExtractionMethodV1,
} from '../contracts/extraction-artifact-v1.js';

export const DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION =
  'defense_budget_promotion_eligibility_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'must be nonblank' });

/** Sorted + de-duplicated identifier list: hashing must not depend on input order. */
const idSet = z
  .array(nonBlank)
  .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b)));

const idSetMin1 = z
  .array(nonBlank)
  .min(1)
  .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b)));

/* ------------------------------------------------------------------ */
/* A1. Terminal statuses that may enter a promotion                    */
/* ------------------------------------------------------------------ */

/**
 * The complete set of candidate statuses a promotion may consider. Everything
 * else — `EXTRACTED`, `VALIDATING`, `STRUCTURALLY_VALIDATED`, `NEEDS_REVIEW`,
 * `REJECTED`, `SUPERSEDED` — is refused. `REVIEW_ACCEPTED` appears here because
 * a human audit decision makes a candidate *considerable*, not because it
 * approves anything.
 */
export const PROMOTION_ELIGIBLE_CANDIDATE_STATUS_V1_VALUES = [
  'VERIFICATION_PASSED',
  'REVIEW_ACCEPTED',
] as const;
export const promotionEligibleCandidateStatusV1Schema = z.enum(
  PROMOTION_ELIGIBLE_CANDIDATE_STATUS_V1_VALUES,
);
export type PromotionEligibleCandidateStatusV1 = z.infer<
  typeof promotionEligibleCandidateStatusV1Schema
>;

/**
 * Extraction methods whose output cannot be self-authorized. Manual entry and
 * OCR are named by the Phase 7 plan; `llamaparse` joins them because it is a
 * paid third-party model whose output no single actor should be able to both
 * produce and approve.
 */
export const HIGH_RISK_EXTRACTION_METHOD_V1_VALUES = [
  'manual',
  'paddleocr',
  'llamaparse',
] as const satisfies readonly ExtractionMethodV1[];

export function isHighRiskExtractionMethodV1(method: ExtractionMethodV1): boolean {
  return (HIGH_RISK_EXTRACTION_METHOD_V1_VALUES as readonly string[]).includes(method);
}

/* ------------------------------------------------------------------ */
/* A2. Promotion scope                                                 */
/* ------------------------------------------------------------------ */

/**
 * What a promotion is allowed to touch. Scope is part of the eligibility hash
 * and is re-checked at activation, so a plan cannot quietly widen after it has
 * been authorized.
 */
export const promotionScopeV1Schema = z
  .object({
    cycleId: nonBlank,
    fiscalYear: z.number().int().min(1900).max(2200),
    families: z
      .array(budgetFamilyV1Schema)
      .min(1)
      .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b))),
    stages: idSet.default([]),
  })
  .strict();
export type PromotionScopeV1 = z.infer<typeof promotionScopeV1Schema>;

/* ------------------------------------------------------------------ */
/* A3. Candidate binding                                               */
/* ------------------------------------------------------------------ */

/**
 * One verified candidate and the exact terminal run that decided it. The run ID
 * is carried so the eligibility service can prove no newer terminal run exists;
 * `extractionMethod` is carried so segregation of duties can be evaluated
 * without a second load.
 */
export const promotionCandidateBindingV1Schema = z
  .object({
    candidateId: nonBlank,
    status: promotionEligibleCandidateStatusV1Schema,
    terminalVerificationRunId: nonBlank,
    extractionMethod: extractionMethodV1Schema,
    extractorActorId: nonBlank.optional(),
    reviewDecisionId: nonBlank.optional(),
    reviewerActorId: nonBlank.optional(),
    acceptedAssertionIds: idSetMin1,
    artifactSha256: sha256Schema,
    sourceSha256: sha256Schema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === 'REVIEW_ACCEPTED' && value.reviewDecisionId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REVIEW_ACCEPTED candidate requires the review decision that accepted it',
        path: ['reviewDecisionId'],
      });
    }
  });
export type PromotionCandidateBindingV1 = z.infer<typeof promotionCandidateBindingV1Schema>;

/* ------------------------------------------------------------------ */
/* A4. Eligibility record                                              */
/* ------------------------------------------------------------------ */

export const defenseBudgetPromotionEligibilityV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION),
    eligibilityId: nonBlank,
    cycleId: nonBlank,
    scope: promotionScopeV1Schema,

    /* Verified Phase 4–6 projections this promotion would draw from. */
    projectionPlanIds: idSetMin1,
    projectionPlanHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),

    /* The mapping registry version that will translate them. */
    mappingRegistryVersion: nonBlank,
    mappingRegistryHash: sha256Schema,

    /* Exact trusted verification records. */
    candidates: z
      .array(promotionCandidateBindingV1Schema)
      .min(1)
      .transform((values) =>
        [...values].sort((a, b) => a.candidateId.localeCompare(b.candidateId)),
      ),

    /* Provenance hashes reloaded from persistence, never from the caller. */
    sourceDocumentHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),
    artifactHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),
    manifestHash: sha256Schema,
    sourceProfileHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),
    verificationPolicyHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),

    /* Cycle certification: Phase 6 must have certified the cycle. */
    cycleCertificationIds: idSetMin1,
    cycleCertificationHashes: z.array(sha256Schema).min(1).transform(sortedShaSet),

    /* What the promotion expects to be active when it runs. */
    expectedActiveSnapshotId: nonBlank.nullable(),
    expectedActiveSnapshotHash: sha256Schema.nullable(),

    /* Blocking counters. Both must be zero for the record to be eligible. */
    openConflictCount: z.number().int().nonnegative(),
    unsupportedItemCount: z.number().int().nonnegative(),

    generatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope.cycleId !== value.cycleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'eligibility scope must describe the same cycle as the eligibility record',
        path: ['scope', 'cycleId'],
      });
    }
    // A baseline promotion has no predecessor; every other promotion must name
    // the snapshot it expects to supersede, with its hash. Half-stated
    // expectations are refused rather than defaulted.
    const hasId = value.expectedActiveSnapshotId != null;
    const hasHash = value.expectedActiveSnapshotHash != null;
    if (hasId !== hasHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'expected active snapshot ID and hash must be supplied together (both null means baseline)',
        path: ['expectedActiveSnapshotHash'],
      });
    }
    if (value.projectionPlanIds.length !== value.projectionPlanHashes.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'every projection plan must carry exactly one plan hash',
        path: ['projectionPlanHashes'],
      });
    }
  })
  .transform(stripUndefinedProperties);
export type DefenseBudgetPromotionEligibilityV1 = z.infer<
  typeof defenseBudgetPromotionEligibilityV1Schema
>;

function sortedShaSet(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ */
/* A5. Eligibility decision                                            */
/* ------------------------------------------------------------------ */

export const PROMOTION_ELIGIBILITY_BLOCK_REASON_V1_VALUES = [
  'candidate_not_terminal',
  'candidate_superseded',
  'newer_terminal_run_exists',
  'assertion_not_accepted',
  'review_decision_missing',
  'cycle_certification_missing',
  'cycle_certification_not_certified',
  'open_blocking_conflict',
  'unsupported_mapping',
  'projection_hash_mismatch',
  'mapping_registry_hash_mismatch',
  'source_profile_expired',
  'policy_version_expired',
  'active_snapshot_expectation_stale',
] as const;
export const promotionEligibilityBlockReasonV1Schema = z.enum(
  PROMOTION_ELIGIBILITY_BLOCK_REASON_V1_VALUES,
);
export type PromotionEligibilityBlockReasonV1 = z.infer<
  typeof promotionEligibilityBlockReasonV1Schema
>;

export interface PromotionEligibilityDecisionV1 {
  schemaVersion: 'defense_budget_promotion_eligibility_decision_v1';
  eligible: boolean;
  eligibilityHash: string | null;
  blocks: { reason: PromotionEligibilityBlockReasonV1; detail: string }[];
}

/**
 * Deterministic hash of an eligibility record. Because the schema sorts every
 * identifier collection during parse, two records built from the same facts in
 * different orders hash identically — which is what lets an authorization bind
 * to eligibility by hash rather than by object identity.
 */
export function promotionEligibilityHashV1(value: DefenseBudgetPromotionEligibilityV1): string {
  return sha256CanonicalJson(value as unknown as Parameters<typeof sha256CanonicalJson>[0]);
}

/**
 * Evaluate a parsed eligibility record. This is the pure policy half: it never
 * loads anything. The service layer is responsible for reloading the trusted
 * records from persistence and building the record passed in here — callers may
 * not hand in their own proof objects.
 */
export function evaluatePromotionEligibilityV1(
  value: DefenseBudgetPromotionEligibilityV1,
): PromotionEligibilityDecisionV1 {
  const blocks: PromotionEligibilityDecisionV1['blocks'] = [];

  if (value.openConflictCount > 0) {
    blocks.push({
      reason: 'open_blocking_conflict',
      detail: `${value.openConflictCount} open blocking conflict(s) in scope`,
    });
  }
  if (value.unsupportedItemCount > 0) {
    blocks.push({
      reason: 'unsupported_mapping',
      detail: `${value.unsupportedItemCount} projection item(s) have no canonical mapping`,
    });
  }
  if (value.cycleCertificationIds.length === 0) {
    blocks.push({
      reason: 'cycle_certification_missing',
      detail: 'promotion scope has no cycle certification',
    });
  }
  for (const candidate of value.candidates) {
    if (candidate.status === 'REVIEW_ACCEPTED' && candidate.reviewDecisionId == null) {
      blocks.push({
        reason: 'review_decision_missing',
        detail: `candidate ${candidate.candidateId} is REVIEW_ACCEPTED with no review decision`,
      });
    }
  }

  return {
    schemaVersion: 'defense_budget_promotion_eligibility_decision_v1',
    eligible: blocks.length === 0,
    eligibilityHash: blocks.length === 0 ? promotionEligibilityHashV1(value) : null,
    blocks,
  };
}
