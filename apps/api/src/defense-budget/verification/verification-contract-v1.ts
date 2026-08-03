/**
 * defense_budget_verification_v1 — trusted verification contract.
 *
 * This is the V1 trusted verification gate contract. It defines the strict
 * vocabulary, shapes, and Zod schemas for verification checks, discrepancies,
 * results, and requests. It is a TRUST BOUNDARY: verification validity is not
 * canonical approval. A VERIFICATION_PASSED result contains no canonical
 * implication.
 *
 * Everything externally loaded is runtime-validated with Zod and strict:
 * unknown fields fail closed. No `any` appears in the exported contract.
 */
import { z } from 'zod';
import {
  budgetFamilyV1Schema,
  exhibitV1Schema,
  extractionMethodV1Schema,
  fundingFieldV1Schema,
  jsonMetadataSchema,
  jsonValueSchema,
  sha256Schema,
  type BudgetFamilyV1,
  type ExhibitV1,
  type ExtractionMethodV1,
  type FundingFieldV1,
  type BudgetLineKindV1,
  type JsonValue,
} from '../contracts/extraction-artifact-v1.js';
import {
  budgetLineKindV1Schema,
  requiredDataCategoryV1Schema,
  type RequiredDataCategoryV1,
} from '../contracts/budget-cycle-manifest-v1.js';

/* ------------------------------------------------------------------ */
/* A1. Version constants                                               */
/* ------------------------------------------------------------------ */

export const DEFENSE_BUDGET_VERIFIER_VERSION = 'defense_budget_verifier_v1' as const;

export const DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION =
  'defense_budget_verification_policy_v1' as const;

/* ------------------------------------------------------------------ */
/* A2. Lifecycle vocabulary                                            */
/* ------------------------------------------------------------------ */

export const VERIFICATION_CANDIDATE_STATUS_V1_VALUES = [
  'EXTRACTED',
  'VALIDATING',
  'STRUCTURALLY_VALIDATED',
  'VERIFICATION_PASSED',
  'NEEDS_REVIEW',
  'REVIEW_ACCEPTED',
  'REJECTED',
  'SUPERSEDED',
] as const;
export const verificationCandidateStatusV1Schema = z.enum(VERIFICATION_CANDIDATE_STATUS_V1_VALUES);
export type VerificationCandidateStatusV1 = z.infer<typeof verificationCandidateStatusV1Schema>;

/**
 * `STRUCTURALLY_VALIDATED` may exist as an intermediate/input state from
 * Phase 0. `VERIFICATION_PASSED` is the final machine-verification decision for
 * Phase 2. `REVIEW_ACCEPTED` is a final audit-review decision. Neither
 * authorizes canonical writes.
 *
 * `CANONICAL`, `PROMOTED`, `promotionReady`, and `canonicalEligible` are
 * prohibited.
 */

/* ------------------------------------------------------------------ */
/* A3. Check outcome vocabulary                                        */
/* ------------------------------------------------------------------ */

export const CHECK_OUTCOME_V1_VALUES = ['PASS', 'FAIL', 'NOT_RUN', 'SKIPPED'] as const;
export const checkOutcomeV1Schema = z.enum(CHECK_OUTCOME_V1_VALUES);
export type CheckOutcomeV1 = z.infer<typeof checkOutcomeV1Schema>;

/**
 * - `PASS`: the rule executed and passed.
 * - `FAIL`: the rule executed and failed.
 * - `NOT_RUN`: required inputs were unavailable or no provider/reference was
 *   supplied.
 * - `SKIPPED`: policy explicitly determined the rule is inapplicable.
 *
 * `NOT_RUN` and `SKIPPED` are never represented as `PASS`.
 */

/* ------------------------------------------------------------------ */
/* A4. Decision vocabulary                                             */
/* ------------------------------------------------------------------ */

export const VERIFICATION_DECISION_V1_VALUES = ['PASS', 'REVIEW', 'REJECT'] as const;
export const verificationDecisionV1Schema = z.enum(VERIFICATION_DECISION_V1_VALUES);
export type VerificationDecisionV1 = z.infer<typeof verificationDecisionV1Schema>;

/**
 * Map to candidate statuses:
 *   PASS   -> VERIFICATION_PASSED
 *   REVIEW -> NEEDS_REVIEW
 *   REJECT -> REJECTED
 */

/* ------------------------------------------------------------------ */
/* A5. Route vocabulary                                                */
/* ------------------------------------------------------------------ */

export const VERIFICATION_ROUTE_V1_VALUES = [
  'none',
  'targeted_local_reextraction',
  'paid_page_verifier',
  'human_review',
] as const;
export const verificationRouteV1Schema = z.enum(VERIFICATION_ROUTE_V1_VALUES);
export type VerificationRouteV1 = z.infer<typeof verificationRouteV1Schema>;

/**
 * Routes are recommendations only. Phase 2 invokes no parser or paid provider.
 */

/* ------------------------------------------------------------------ */
/* A6. Verification check                                              */
/* ------------------------------------------------------------------ */

export const verificationCheckV1Schema = z
  .object({
    checkId: z.string().min(1),
    code: z.string().min(1),
    ruleVersion: z.string().min(1),
    outcome: checkOutcomeV1Schema,
    required: z.boolean(),
    blocking: z.boolean(),
    riskPoints: z.number().int().min(0).max(100),
    message: z.string(),
    assertionIds: z.array(z.string().min(1)),
    evidenceIds: z.array(z.string().min(1)),
    referenceArtifactIds: z.array(z.string().min(1)),
    details: z.record(jsonValueSchema).optional(),
  })
  .strict();
export type VerificationCheckV1 = z.infer<typeof verificationCheckV1Schema>;

/**
 * `checkId` must be deterministic from the verifier run identity, code,
 * assertion IDs, evidence IDs, and reference artifact IDs.
 */

/* ------------------------------------------------------------------ */
/* A7. Discrepancy                                                     */
/* ------------------------------------------------------------------ */

export const verificationDiscrepancyV1Schema = z
  .object({
    discrepancyId: z.string().min(1),
    code: z.string().min(1),
    severity: z.enum(['blocking', 'review', 'informational']),
    description: z.string(),
    assertionIds: z.array(z.string().min(1)),
    evidenceIds: z.array(z.string().min(1)),
    referenceArtifactIds: z.array(z.string().min(1)),
    details: z.record(jsonValueSchema).optional(),
  })
  .strict();
export type VerificationDiscrepancyV1 = z.infer<typeof verificationDiscrepancyV1Schema>;

/* ------------------------------------------------------------------ */
/* A8. Verification result                                              */
/* ------------------------------------------------------------------ */

const isoDateTimeString = z
  .string()
  .min(1)
  .refine((s) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.test(s), {
    message: 'expected ISO 8601 datetime string',
  });

export const defenseBudgetVerificationResultV1Schema = z
  .object({
    verifierVersion: z.literal(DEFENSE_BUDGET_VERIFIER_VERSION),
    policyVersion: z.literal(DEFENSE_BUDGET_VERIFICATION_POLICY_VERSION),
    policySha256: sha256Schema,
    verificationRunId: z.string().min(1),
    candidateId: z.string().min(1),
    cycleId: z.string().min(1),
    manifestContentSha256: sha256Schema,
    manifestDocumentKey: z.string().min(1),
    extractionArtifactId: z.string().min(1),
    extractionArtifactSha256: sha256Schema,
    sourceDocumentId: z.string().min(1),
    sourcePdfSha256: sha256Schema,
    decision: verificationDecisionV1Schema,
    status: verificationCandidateStatusV1Schema,
    route: verificationRouteV1Schema,
    riskScore: z.number().int().min(0).max(100),
    checks: z.array(verificationCheckV1Schema),
    discrepancies: z.array(verificationDiscrepancyV1Schema),
    acceptedAssertionIds: z.array(z.string().min(1)),
    rejectedAssertionIds: z.array(z.string().min(1)),
    referenceArtifactIds: z.array(z.string().min(1)),
    startedAt: isoDateTimeString,
    completedAt: isoDateTimeString,
  })
  .strict()
  .refine((result) => result.completedAt >= result.startedAt, {
    message: 'completedAt must be >= startedAt',
    path: ['completedAt'],
  })
  .refine((result) => result.decision !== 'REJECT' || result.acceptedAssertionIds.length === 0, {
    message: 'a rejected result must have an empty acceptedAssertionIds list',
    path: ['acceptedAssertionIds'],
  });
export type DefenseBudgetVerificationResultV1 = z.infer<
  typeof defenseBudgetVerificationResultV1Schema
>;

/**
 * Rules:
 * - The result contains assertion IDs only, not canonical writer inputs.
 * - `acceptedAssertionIds` means "passed verification checks," not "approved
 *   for canonical write."
 * - A rejected result must have an empty `acceptedAssertionIds` list.
 * - Timestamps must be valid and `completedAt >= startedAt`.
 * - `riskScore` is bounded `0..100`.
 */

/* ------------------------------------------------------------------ */
/* A9. Verification request                                            */
/* ------------------------------------------------------------------ */

export const verificationRequestV1Schema = z
  .object({
    manifestLocator: z.string().min(1),
    manifestDocumentKey: z.string().min(1),
    extractionArtifactLocator: z.string().min(1),
    sourceDocumentId: z.string().min(1),
    referenceArtifactLocators: z.array(z.string().min(1)).optional(),
    mode: z.enum(['inspect', 'persist_audit']),
    expectedSourcePdfSha256: sha256Schema.optional(),
    expectedExtractionArtifactSha256: sha256Schema.optional(),
  })
  .strict();
export type VerificationRequestV1 = z.infer<typeof verificationRequestV1Schema>;

/**
 * The optional expected hashes are TOCTOU/operator confirmation guards only.
 * They do not establish trust.
 *
 * The request must NOT accept:
 *   archiveProof, parseProof, approvedSha256, promotionReady, canonicalEligible
 */

/* ------------------------------------------------------------------ */
/* Re-exported Phase 1 types used by the policy contract                */
/* ------------------------------------------------------------------ */

export {
  budgetFamilyV1Schema,
  exhibitV1Schema,
  extractionMethodV1Schema,
  fundingFieldV1Schema,
  requiredDataCategoryV1Schema,
  budgetLineKindV1Schema,
  jsonMetadataSchema,
  sha256Schema,
  type BudgetFamilyV1,
  type ExhibitV1,
  type ExtractionMethodV1,
  type FundingFieldV1,
  type BudgetLineKindV1,
  type RequiredDataCategoryV1,
  type JsonValue,
};

/* ------------------------------------------------------------------ */
/* Deterministic check ID                                              */
/* ------------------------------------------------------------------ */

import { createHash } from 'node:crypto';

/**
 * Compute a deterministic check ID from the verifier run identity, code,
 * assertion IDs, evidence IDs, and reference artifact IDs.
 *
 * The ID is `vc1_<sha256>` where the hash covers:
 *   verificationRunId | code | sorted(assertionIds) | sorted(evidenceIds) |
 *   sorted(referenceArtifactIds)
 */
export function computeVerificationCheckId(input: {
  verificationRunId: string;
  code: string;
  assertionIds: readonly string[];
  evidenceIds: readonly string[];
  referenceArtifactIds: readonly string[];
}): string {
  const sortedAssertions = [...input.assertionIds].sort().join(',');
  const sortedEvidence = [...input.evidenceIds].sort().join(',');
  const sortedReferences = [...input.referenceArtifactIds].sort().join(',');
  const material = [
    input.verificationRunId,
    input.code,
    sortedAssertions,
    sortedEvidence,
    sortedReferences,
  ].join('|');
  return `vc1_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}

/**
 * Compute a deterministic discrepancy ID from code, assertion IDs, evidence
 * IDs, and reference artifact IDs.
 */
export function computeVerificationDiscrepancyId(input: {
  code: string;
  assertionIds: readonly string[];
  evidenceIds: readonly string[];
  referenceArtifactIds: readonly string[];
}): string {
  const sortedAssertions = [...input.assertionIds].sort().join(',');
  const sortedEvidence = [...input.evidenceIds].sort().join(',');
  const sortedReferences = [...input.referenceArtifactIds].sort().join(',');
  const material = [input.code, sortedAssertions, sortedEvidence, sortedReferences].join('|');
  return `vd1_${createHash('sha256').update(material, 'utf8').digest('hex')}`;
}
