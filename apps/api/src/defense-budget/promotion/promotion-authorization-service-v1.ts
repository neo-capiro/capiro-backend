/**
 * Phase 7 Workstream A.10 — the guarded surface that issues authorizations.
 *
 * Deliberately added last. The plan requires the pure service and policy to be
 * complete before any admin surface exists, and the surface must not be able to
 * write a canonical row — which could only be demonstrated once Workstream D
 * had defined what a canonical row is and which role may write one.
 *
 * The capability boundary here is narrow by construction:
 *
 *   * The only persistence port this service holds is
 *     `PromotionAuthorizationRepositoryV1`, whose entire write surface is
 *     `insertAuthorization`. There is no method that touches a snapshot, a run,
 *     an activation, or a canonical row, so no amount of misuse reaches them.
 *   * It runs under the general API serve role. Migration 20260822010000
 *     revokes canonical DML from `capiro_app` and the canonical-row trigger
 *     refuses any writer that is not `capiro_pe_promoter`, so the database
 *     enforces the same boundary independently.
 *   * Segregation of duties is checked twice: once here against the loaded
 *     eligibility, and again inside
 *     `defenseBudgetPromotionAuthorizationV1Schema`, which refuses an
 *     authorizer who reviewed or (for high-risk extraction) extracted the same
 *     scope. A caller that forgets the first check still cannot bypass the
 *     second.
 *   * The persisted eligibility record is not trusted merely because its hash
 *     is real. Authorization reruns the deterministic eligibility policy and
 *     refuses a record that now evaluates blocked. This matters because the
 *     file-plan verb is intentionally a narrow persistence primitive: without
 *     this second check, a hand-authored plan could point at a genuine but
 *     ineligible record and understate its own blocked count.
 *
 * An authorization is issued against a plan that already exists in persistence
 * and is reloaded here. The requester supplies a plan ID, a reason, and an
 * expiry — never a hash, never a scope, never a segregation claim.
 */
import {
  defenseBudgetPromotionAuthorizationV1Schema,
  deriveSegregationEvidenceV1,
  promotionAuthorizationHashV1,
  type DefenseBudgetPromotionAuthorizationV1,
} from './promotion-authorization-v1.js';
import {
  evaluatePromotionEligibilityV1,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
} from './promotion-eligibility-v1.js';
import { sha256CanonicalJson, type JsonValue } from '../contracts/canonical-json.js';
import type { PromotionAuditSinkV1 } from './promotion-eligibility-service-v1.js';

/* ------------------------------------------------------------------ */
/* A10a. Request                                                       */
/* ------------------------------------------------------------------ */

export interface IssueAuthorizationRequestV1 {
  planId: string;
  reason: string;
  expiresAt: string;
  authorizerActorId: string;
  /** Roles the authenticated caller actually holds, from the auth layer. */
  authorizerRoles: string[];
  changeRequestReference?: string;
  /** Deterministic identifier supplied by the caller's convention. */
  authorizationId: string;
}

/* ------------------------------------------------------------------ */
/* A10b. Ports                                                         */
/* ------------------------------------------------------------------ */

export interface StoredPromotionPlanV1 {
  planId: string;
  planHash: string;
  eligibilityHash: string;
  blockedCount: number;
  expectedActiveSnapshotId: string | null;
  /** The exact eligibility record the plan was built from. */
  eligibility: DefenseBudgetPromotionEligibilityV1;
}

/**
 * The complete persistence surface of the admin path. Note that it can read a
 * plan and append an authorization, and nothing else: there is no snapshot,
 * run, activation, outbox, or canonical-row method to call.
 */
export interface PromotionAuthorizationRepositoryV1 {
  loadPlan(planId: string): Promise<StoredPromotionPlanV1 | null>;
  findAuthorizationById(authorizationId: string): Promise<{ authorizationId: string } | null>;
  insertAuthorization(
    record: DefenseBudgetPromotionAuthorizationV1 & { authorizationHash: string },
  ): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* A10c. Result                                                        */
/* ------------------------------------------------------------------ */

export const AUTHORIZATION_ISSUE_REFUSAL_V1_VALUES = [
  'authorizer_not_admin',
  'plan_not_found',
  'plan_has_blocked_items',
  'eligibility_not_eligible',
  'authorization_already_exists',
  'expiry_not_in_future',
  'segregation_violation',
  'eligibility_hash_mismatch',
  'invalid_authorization',
] as const;
export type AuthorizationIssueRefusalV1 = (typeof AUTHORIZATION_ISSUE_REFUSAL_V1_VALUES)[number];

export interface IssueAuthorizationResultV1 {
  issued: boolean;
  authorization: (DefenseBudgetPromotionAuthorizationV1 & { authorizationHash: string }) | null;
  refusals: { reason: AuthorizationIssueRefusalV1; detail: string }[];
}

export interface PromotionAuthorizationServiceOptionsV1 {
  now: () => Date;
  /** Role required to authorize a promotion. */
  requiredRole?: string;
}

export class DefenseBudgetPromotionAuthorizationServiceV1 {
  private readonly requiredRole: string;

  constructor(
    private readonly repository: PromotionAuthorizationRepositoryV1,
    private readonly audit: PromotionAuditSinkV1,
    private readonly options: PromotionAuthorizationServiceOptionsV1,
  ) {
    this.requiredRole = options.requiredRole ?? 'capiro_admin';
  }

  async issue(request: IssueAuthorizationRequestV1): Promise<IssueAuthorizationResultV1> {
    const refusals: IssueAuthorizationResultV1['refusals'] = [];

    if (!request.authorizerRoles.includes(this.requiredRole)) {
      refusals.push({
        reason: 'authorizer_not_admin',
        detail: `promotion authorization requires ${this.requiredRole}`,
      });
      return this.refuse(request, refusals, null);
    }

    const plan = await this.repository.loadPlan(request.planId);
    if (plan == null) {
      refusals.push({ reason: 'plan_not_found', detail: `plan ${request.planId} does not exist` });
      return this.refuse(request, refusals, null);
    }

    if (plan.blockedCount > 0) {
      refusals.push({
        reason: 'plan_has_blocked_items',
        detail: `plan ${plan.planId} has ${plan.blockedCount} blocked item(s) and may not be authorized`,
      });
    }

    // A persisted eligibility document is evidence, not an authorization token.
    // Re-evaluate the pure policy rather than assuming a caller-created plan was
    // honest about whether that record was promotable.
    const eligibilityDecision = evaluatePromotionEligibilityV1(plan.eligibility);
    if (!eligibilityDecision.eligible) {
      refusals.push({
        reason: 'eligibility_not_eligible',
        detail:
          `eligibility ${plan.eligibilityHash} is blocked: ` +
          eligibilityDecision.blocks
            .map((block) => `${block.reason}:${block.detail}`)
            .join('; '),
      });
    }

    const existing = await this.repository.findAuthorizationById(request.authorizationId);
    if (existing != null) {
      refusals.push({
        reason: 'authorization_already_exists',
        detail: `authorization ${request.authorizationId} already exists and is immutable`,
      });
    }

    const issuedAt = this.options.now();
    if (Date.parse(request.expiresAt) <= issuedAt.getTime()) {
      refusals.push({
        reason: 'expiry_not_in_future',
        detail: 'an authorization must expire after it is issued',
      });
    }

    // The plan's recorded eligibility hash must still match the eligibility it
    // carries; a mismatch means one of the two was tampered with in storage.
    const recomputed = promotionEligibilityHashV1(plan.eligibility);
    if (recomputed !== plan.eligibilityHash) {
      refusals.push({
        reason: 'eligibility_hash_mismatch',
        detail: 'the stored plan and its eligibility record disagree',
      });
    }

    if (refusals.length > 0) return this.refuse(request, refusals, plan);

    // Segregation evidence is derived from the eligibility record, never taken
    // from the requester, so an authorizer cannot understate their involvement.
    const segregation = deriveSegregationEvidenceV1(plan.eligibility, request.authorizerActorId);

    const parsed = defenseBudgetPromotionAuthorizationV1Schema.safeParse({
      schemaVersion: 'defense_budget_promotion_authorization_v1',
      authorizationId: request.authorizationId,
      eligibilityHash: plan.eligibilityHash,
      planId: plan.planId,
      planHash: plan.planHash,
      scope: plan.eligibility.scope,
      expectedActiveSnapshotId: plan.expectedActiveSnapshotId,
      authorizerActorId: request.authorizerActorId,
      reason: request.reason,
      issuedAt: issuedAt.toISOString(),
      expiresAt: request.expiresAt,
      segregation,
      ...(request.changeRequestReference != null
        ? { changeRequestReference: request.changeRequestReference }
        : {}),
    });

    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => issue.message);
      const isSegregation = messages.some((message) => message.includes('authorizer may not'));
      refusals.push({
        reason: isSegregation ? 'segregation_violation' : 'invalid_authorization',
        detail: messages.join('; '),
      });
      return this.refuse(request, refusals, plan);
    }

    const authorization = parsed.data;
    const record = {
      ...authorization,
      authorizationHash: promotionAuthorizationHashV1(authorization),
    };
    await this.repository.insertAuthorization(record);

    await this.audit.record({
      attemptKind: 'AUTHORIZATION',
      outcome: 'ALLOWED',
      actorId: request.authorizerActorId,
      cycleId: plan.eligibility.cycleId,
      scope: { scopeHash: sha256CanonicalJson(plan.eligibility.scope as unknown as JsonValue) },
      eligibilityHash: plan.eligibilityHash,
      planId: plan.planId,
      planHash: plan.planHash,
      authorizationId: record.authorizationId,
      expectedActiveSnapshotId: plan.expectedActiveSnapshotId,
      reasons: [],
      detail: null,
    });

    return { issued: true, authorization: record, refusals: [] };
  }

  private async refuse(
    request: IssueAuthorizationRequestV1,
    refusals: IssueAuthorizationResultV1['refusals'],
    plan: StoredPromotionPlanV1 | null,
  ): Promise<IssueAuthorizationResultV1> {
    await this.audit.record({
      attemptKind: 'AUTHORIZATION',
      outcome: 'REFUSED',
      actorId: request.authorizerActorId,
      cycleId: plan?.eligibility.cycleId ?? null,
      scope: null,
      eligibilityHash: plan?.eligibilityHash ?? null,
      planId: request.planId,
      planHash: plan?.planHash ?? null,
      authorizationId: request.authorizationId,
      expectedActiveSnapshotId: plan?.expectedActiveSnapshotId ?? null,
      reasons: refusals.map((refusal) => refusal.reason),
      detail: refusals.map((refusal) => refusal.detail).join('; '),
    });
    return { issued: false, authorization: null, refusals };
  }
}
