/**
 * Phase 7 Workstream A — `defense_budget_promotion_authorization_v1`.
 *
 * The second, independent gate. Eligibility says the trusted inputs line up;
 * authorization says a named `capiro_admin` decided that this exact plan, at
 * this exact scope, against this exact expected active snapshot, may be
 * promoted — once, before a stated expiry.
 *
 * Every binding is exact and hash-based. There is deliberately no reusable
 * "approved SHA" flag, no scope widening, and no way for the authorizer to
 * alter the accepted assertions or the mapping registry: an authorization that
 * does not match the plan it is presented with simply fails closed.
 *
 * Segregation of duties is enforced here rather than in a service so it cannot
 * be skipped by a caller that forgets to invoke a checker.
 */
import { z } from 'zod';
import { sha256CanonicalJson, stripUndefinedProperties } from '../contracts/canonical-json.js';
import { sha256Schema } from '../contracts/extraction-artifact-v1.js';
import {
  isHighRiskExtractionMethodV1,
  promotionScopeV1Schema,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';

export const DEFENSE_BUDGET_PROMOTION_AUTHORIZATION_SCHEMA_VERSION =
  'defense_budget_promotion_authorization_v1' as const;

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, { message: 'must be nonblank' });

/* ------------------------------------------------------------------ */
/* A6. Segregation evidence                                            */
/* ------------------------------------------------------------------ */

/**
 * Who did what, recorded at authorization time so the separation can be audited
 * later without re-deriving it from mutable role tables.
 */
export const promotionSegregationEvidenceV1Schema = z
  .object({
    authorizerActorId: nonBlank,
    authorizerRole: z.literal('capiro_admin'),
    reviewerActorIds: z
      .array(nonBlank)
      .default([])
      .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b))),
    extractorActorIds: z
      .array(nonBlank)
      .default([])
      .transform((values) => [...new Set(values)].sort((a, b) => a.localeCompare(b))),
    highRiskExtractionPresent: z.boolean(),
  })
  .strict();
export type PromotionSegregationEvidenceV1 = z.infer<typeof promotionSegregationEvidenceV1Schema>;

/* ------------------------------------------------------------------ */
/* A7. Authorization record                                            */
/* ------------------------------------------------------------------ */

export const defenseBudgetPromotionAuthorizationV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PROMOTION_AUTHORIZATION_SCHEMA_VERSION),
    authorizationId: nonBlank,

    /* Exact bindings. All four must match at execution time. */
    eligibilityHash: sha256Schema,
    planId: nonBlank,
    planHash: sha256Schema,
    scope: promotionScopeV1Schema,
    expectedActiveSnapshotId: nonBlank.nullable(),

    /* Who authorized, why, and for how long. */
    authorizerActorId: nonBlank,
    reason: nonBlank,
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    segregation: promotionSegregationEvidenceV1Schema,
    changeRequestReference: nonBlank.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'authorization must expire after it is issued',
        path: ['expiresAt'],
      });
    }
    if (value.segregation.authorizerActorId !== value.authorizerActorId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'segregation evidence must describe the same authorizer',
        path: ['segregation', 'authorizerActorId'],
      });
    }
    // Segregation of duties, enforced in the contract so no caller can skip it.
    if (value.segregation.reviewerActorIds.includes(value.authorizerActorId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'promotion authorizer may not be a reviewer of the same scope',
        path: ['segregation', 'reviewerActorIds'],
      });
    }
    if (
      value.segregation.highRiskExtractionPresent &&
      value.segregation.extractorActorIds.includes(value.authorizerActorId)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'promotion authorizer may not be the extractor when the scope contains manual/OCR/high-risk extraction',
        path: ['segregation', 'extractorActorIds'],
      });
    }
  })
  .transform(stripUndefinedProperties);
export type DefenseBudgetPromotionAuthorizationV1 = z.infer<
  typeof defenseBudgetPromotionAuthorizationV1Schema
>;

export function promotionAuthorizationHashV1(value: DefenseBudgetPromotionAuthorizationV1): string {
  return sha256CanonicalJson(value as unknown as Parameters<typeof sha256CanonicalJson>[0]);
}

/* ------------------------------------------------------------------ */
/* A8. Redemption                                                      */
/* ------------------------------------------------------------------ */

export const PROMOTION_AUTHORIZATION_REFUSAL_V1_VALUES = [
  'eligibility_hash_mismatch',
  'plan_id_mismatch',
  'plan_hash_mismatch',
  'scope_mismatch',
  'expected_active_snapshot_mismatch',
  'authorization_expired',
  'authorization_already_used',
  'authorizer_not_admin',
  'authorizer_is_reviewer',
  'authorizer_is_extractor_high_risk',
] as const;
export const promotionAuthorizationRefusalV1Schema = z.enum(
  PROMOTION_AUTHORIZATION_REFUSAL_V1_VALUES,
);
export type PromotionAuthorizationRefusalV1 = z.infer<typeof promotionAuthorizationRefusalV1Schema>;

export interface PromotionAuthorizationDecisionV1 {
  schemaVersion: 'defense_budget_promotion_authorization_decision_v1';
  authorized: boolean;
  refusals: { reason: PromotionAuthorizationRefusalV1; detail: string }[];
}

export interface PromotionRedemptionContextV1 {
  /** Reloaded from persistence by the caller — never supplied by the requester. */
  eligibility: DefenseBudgetPromotionEligibilityV1;
  eligibilityHash: string;
  planId: string;
  planHash: string;
  /** The snapshot actually active right now, read under lock at execution time. */
  actualActiveSnapshotId: string | null;
  /** Whether the activation ledger already records this authorization as consumed. */
  alreadyUsed: boolean;
  /** Injected so redemption is a pure function and remains replayable. */
  now: Date;
}

/**
 * Decide whether an authorization may be redeemed against a concrete plan and a
 * concrete live snapshot pointer.
 *
 * Fails closed on every mismatch and reports all refusals rather than the first,
 * so an operator sees the whole reason a promotion was rejected.
 */
export function evaluatePromotionAuthorizationV1(
  authorization: DefenseBudgetPromotionAuthorizationV1,
  context: PromotionRedemptionContextV1,
): PromotionAuthorizationDecisionV1 {
  const refusals: PromotionAuthorizationDecisionV1['refusals'] = [];

  if (authorization.eligibilityHash !== context.eligibilityHash) {
    refusals.push({
      reason: 'eligibility_hash_mismatch',
      detail: 'authorization was issued against different eligibility facts',
    });
  }
  if (authorization.planId !== context.planId) {
    refusals.push({ reason: 'plan_id_mismatch', detail: 'authorization names a different plan' });
  }
  if (authorization.planHash !== context.planHash) {
    refusals.push({
      reason: 'plan_hash_mismatch',
      detail: 'the plan changed after it was authorized; a new authorization is required',
    });
  }
  if (sha256CanonicalJson(authorization.scope) !== sha256CanonicalJson(context.eligibility.scope)) {
    refusals.push({
      reason: 'scope_mismatch',
      detail: 'authorization scope does not equal the eligibility scope',
    });
  }
  if (authorization.expectedActiveSnapshotId !== context.actualActiveSnapshotId) {
    refusals.push({
      reason: 'expected_active_snapshot_mismatch',
      detail: `authorization expected active snapshot ${
        authorization.expectedActiveSnapshotId ?? '(baseline/none)'
      }, found ${context.actualActiveSnapshotId ?? '(baseline/none)'}`,
    });
  }
  if (context.now.getTime() > Date.parse(authorization.expiresAt)) {
    refusals.push({
      reason: 'authorization_expired',
      detail: `authorization expired at ${authorization.expiresAt}`,
    });
  }
  if (context.alreadyUsed) {
    refusals.push({
      reason: 'authorization_already_used',
      detail: 'authorization is one-use and has already been consumed',
    });
  }
  if (authorization.segregation.authorizerRole !== 'capiro_admin') {
    refusals.push({
      reason: 'authorizer_not_admin',
      detail: 'promotion authorizer must hold capiro_admin',
    });
  }
  if (authorization.segregation.reviewerActorIds.includes(authorization.authorizerActorId)) {
    refusals.push({
      reason: 'authorizer_is_reviewer',
      detail: 'promotion authorizer reviewed the same scope',
    });
  }
  if (
    authorization.segregation.highRiskExtractionPresent &&
    authorization.segregation.extractorActorIds.includes(authorization.authorizerActorId)
  ) {
    refusals.push({
      reason: 'authorizer_is_extractor_high_risk',
      detail: 'promotion authorizer extracted high-risk content in the same scope',
    });
  }

  return {
    schemaVersion: 'defense_budget_promotion_authorization_decision_v1',
    authorized: refusals.length === 0,
    refusals,
  };
}

/**
 * Derive the segregation evidence an authorization must carry for a given
 * eligibility record. Building it from the eligibility rather than from operator
 * input is what stops an authorizer from understating their own involvement.
 */
export function deriveSegregationEvidenceV1(
  eligibility: DefenseBudgetPromotionEligibilityV1,
  authorizerActorId: string,
): PromotionSegregationEvidenceV1 {
  const reviewerActorIds = new Set<string>();
  const extractorActorIds = new Set<string>();
  let highRiskExtractionPresent = false;

  for (const candidate of eligibility.candidates) {
    if (candidate.reviewerActorId != null) reviewerActorIds.add(candidate.reviewerActorId);
    if (candidate.extractorActorId != null) extractorActorIds.add(candidate.extractorActorId);
    if (isHighRiskExtractionMethodV1(candidate.extractionMethod)) {
      highRiskExtractionPresent = true;
    }
  }

  return promotionSegregationEvidenceV1Schema.parse({
    authorizerActorId,
    authorizerRole: 'capiro_admin',
    reviewerActorIds: [...reviewerActorIds],
    extractorActorIds: [...extractorActorIds],
    highRiskExtractionPresent,
  });
}
