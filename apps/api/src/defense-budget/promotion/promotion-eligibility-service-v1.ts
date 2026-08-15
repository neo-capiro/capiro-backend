/**
 * Phase 7 Workstream A.7 and A.9 — the eligibility loading layer and its
 * append-only audit.
 *
 * Workstream A already established the eligibility *contract* and the pure
 * policy that evaluates it. What was still owed is the part that decides what
 * goes into that contract, and the rule there is short: **the caller supplies a
 * scope, never a proof.**
 *
 * `PromotionEligibilityRequestV1` deliberately contains no hashes, no candidate
 * IDs, no run IDs, and no assertion lists. Every one of those is reloaded from
 * trusted persistence by this service. An operator asking "may FY2027 O&M be
 * promoted?" cannot influence the answer beyond naming the cycle, the families,
 * and the environment — which is what makes the resulting eligibility hash
 * meaningful as an authorization subject.
 *
 * The service is service-neutral by construction: it depends on two narrow
 * ports rather than on Nest or Prisma, so Phase 8 can move it into
 * `apps/program-elements-service` without a semantic rewrite, and tests can
 * drive it with in-memory fakes.
 *
 * Every attempt is audited, allowed or refused. Refusals are the interesting
 * half and carry their reasons; the append-only trigger on
 * `defense_budget_promotion_audit` means an audit row cannot later be edited
 * away.
 */
import {
  DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
  defenseBudgetPromotionEligibilityV1Schema,
  evaluatePromotionEligibilityV1,
  promotionEligibilityHashV1,
  type DefenseBudgetPromotionEligibilityV1,
  type PromotionEligibilityBlockReasonV1,
  type PromotionEligibilityDecisionV1,
} from './promotion-eligibility-v1.js';
import {
  DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
  canonicalMappingRegistryHashV1,
} from './canonical-mapping-registry-v1.js';
import { familyRequiresStageSourceProfileV1 } from '../stages/stage-source-profile-coverage-v1.js';
import { NOOP_SLO_METRIC_RECORDER_V1, type SloMetricRecorderV1 } from './slo-metrics-v1.js';
import type { BudgetFamilyV1, ExtractionMethodV1 } from '../contracts/extraction-artifact-v1.js';

/* ------------------------------------------------------------------ */
/* A7a. What a caller may ask for                                      */
/* ------------------------------------------------------------------ */

/**
 * The complete request surface. Note what is absent: no hashes, no candidate or
 * run identifiers, no assertion lists, no snapshot expectation. A caller can
 * name a scope and nothing else.
 */
export interface PromotionEligibilityRequestV1 {
  cycleId: string;
  fiscalYear: number;
  families: BudgetFamilyV1[];
  stages?: string[];
  domain?: string;
  environment: string;
  /** Recorded in the audit trail; never used to decide the outcome. */
  requestedByActorId?: string;
}

/* ------------------------------------------------------------------ */
/* A7b. Trusted records, as loaded from persistence                    */
/* ------------------------------------------------------------------ */

export interface TrustedCandidateRecordV1 {
  candidateId: string;
  status: string;
  /** The run the candidate's current terminal status came from. */
  terminalVerificationRunId: string | null;
  /**
   * Phase 7 Gap 5 decision 1: read from `budget_extraction_candidate_v1.family`,
   * denormalized there from the artifact at verification time. A repository that
   * cannot supply it must refuse the candidate rather than widen the scope.
   */
  family: BudgetFamilyV1;
  extractionMethod: ExtractionMethodV1;
  extractorActorId?: string | null;
  reviewDecisionId?: string | null;
  reviewerActorId?: string | null;
  acceptedAssertionIds: string[];
  artifactSha256: string;
  sourceSha256: string;
  /**
   * Phase 7 Gap 5 decision 2: the governed `DefenseBudgetStageSourceProfileV1`
   * hash this candidate was extracted under, or `null` for a family that has no
   * such artifact. `null` is a legitimate answer for Phase 1–5 families and a
   * blocking one for Phase 6 families — see `familyRequiresStageSourceProfileV1`.
   */
  sourceProfileSha256: string | null;
  verificationPolicySha256: string;
  manifestSha256: string;
}

export interface TrustedProjectionPlanRecordV1 {
  projectionPlanId: string;
  contentSha256: string;
}

export interface TrustedCycleCertificationRecordV1 {
  certificationId: string;
  contentSha256: string;
  status: string;
}

export interface TrustedActiveSnapshotRecordV1 {
  snapshotId: string;
  snapshotHash: string;
}

/**
 * Everything the service is allowed to read. Each method is scoped by cycle and
 * family so an implementation cannot accidentally widen the query.
 */
export interface PromotionEligibilityRepositoryV1 {
  loadCycleCertifications(
    cycleId: string,
    fiscalYear: number,
  ): Promise<TrustedCycleCertificationRecordV1[]>;

  loadCandidates(cycleId: string, families: BudgetFamilyV1[]): Promise<TrustedCandidateRecordV1[]>;

  /**
   * The newest terminal run for a candidate, whatever it is. If this disagrees
   * with the run the candidate record names, a newer verification has happened
   * and the older result may not be promoted.
   */
  loadLatestTerminalRunId(candidateId: string): Promise<string | null>;

  loadProjectionPlans(
    cycleId: string,
    families: BudgetFamilyV1[],
  ): Promise<TrustedProjectionPlanRecordV1[]>;

  countOpenBlockingConflicts(cycleId: string, families: BudgetFamilyV1[]): Promise<number>;

  countUnsupportedProjections(cycleId: string, families: BudgetFamilyV1[]): Promise<number>;

  loadActiveSnapshot(
    domain: string,
    environment: string,
  ): Promise<TrustedActiveSnapshotRecordV1 | null>;
}

/* ------------------------------------------------------------------ */
/* A9. Audit                                                           */
/* ------------------------------------------------------------------ */

export const PROMOTION_AUDIT_ATTEMPT_KIND_V1_VALUES = [
  'ELIGIBILITY',
  'AUTHORIZATION',
  'REDEMPTION',
] as const;
export type PromotionAuditAttemptKindV1 = (typeof PROMOTION_AUDIT_ATTEMPT_KIND_V1_VALUES)[number];

export interface PromotionAuditEntryV1 {
  attemptKind: PromotionAuditAttemptKindV1;
  outcome: 'ALLOWED' | 'REFUSED';
  actorId: string | null;
  cycleId: string | null;
  scope: Record<string, unknown> | null;
  eligibilityHash: string | null;
  planId: string | null;
  planHash: string | null;
  authorizationId: string | null;
  expectedActiveSnapshotId: string | null;
  reasons: string[];
  detail: string | null;
}

/** Append-only sink. Implementations must never update or delete. */
export interface PromotionAuditSinkV1 {
  record(entry: PromotionAuditEntryV1): Promise<void>;
}

/** Minimal shape of the generated Prisma delegate this adapter needs. */
export interface PromotionAuditPrismaDelegateV1 {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
}

/**
 * Prisma-backed audit sink. Deliberately typed against the narrowest possible
 * delegate shape rather than importing PrismaClient, so this module stays free
 * of a Prisma dependency and Phase 8 can relocate it unchanged.
 *
 * Only `create` is ever called. The append-only trigger on the table would
 * refuse anything else anyway, but not offering the method makes that explicit.
 */
export class PrismaPromotionAuditSinkV1 implements PromotionAuditSinkV1 {
  constructor(private readonly delegate: PromotionAuditPrismaDelegateV1) {}

  async record(entry: PromotionAuditEntryV1): Promise<void> {
    await this.delegate.create({
      data: {
        attemptKind: entry.attemptKind,
        outcome: entry.outcome,
        actorId: entry.actorId,
        cycleId: entry.cycleId,
        scope: entry.scope ?? undefined,
        eligibilityHash: entry.eligibilityHash,
        planId: entry.planId,
        planHash: entry.planHash,
        authorizationId: entry.authorizationId,
        expectedActiveSnapshotId: entry.expectedActiveSnapshotId,
        reasons: entry.reasons,
        detail: entry.detail,
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* A7c. Result                                                         */
/* ------------------------------------------------------------------ */

export interface PromotionEligibilityResultV1 {
  eligible: boolean;
  /** Present only when the loaded facts formed a valid eligibility record. */
  eligibility: DefenseBudgetPromotionEligibilityV1 | null;
  eligibilityHash: string | null;
  decision: PromotionEligibilityDecisionV1 | null;
  blocks: { reason: PromotionEligibilityBlockReasonV1; detail: string }[];
}

const TERMINAL_PROMOTABLE_STATUSES = new Set(['VERIFICATION_PASSED', 'REVIEW_ACCEPTED']);

export interface PromotionEligibilityServiceOptionsV1 {
  /** Injected so the service stays pure and replayable. */
  now: () => Date;
  /** Deterministic eligibility identifier, derived by the caller's convention. */
  eligibilityId: (request: PromotionEligibilityRequestV1) => string;
  /**
   * Phase 7 Gap 5 decision C. Optional and defaulted to a no-op, so every
   * existing caller keeps compiling unchanged. Measures
   * `eligibility_evaluation_latency_ms` around the whole evaluation — not only
   * the allowed path, since a slow refusal is still a latency fact an SLO
   * needs to see. The threshold this emits is always
   * `THRESHOLD_PENDING_ROLLOUT_BASELINE`; see `slo-metrics-v1.ts`.
   */
  sloMetrics?: SloMetricRecorderV1;
}

/**
 * Builds an eligibility record from trusted persistence and evaluates it.
 */
export class DefenseBudgetPromotionEligibilityServiceV1 {
  private readonly sloMetrics: SloMetricRecorderV1;

  constructor(
    private readonly repository: PromotionEligibilityRepositoryV1,
    private readonly audit: PromotionAuditSinkV1,
    private readonly options: PromotionEligibilityServiceOptionsV1,
  ) {
    this.sloMetrics = options.sloMetrics ?? NOOP_SLO_METRIC_RECORDER_V1;
  }

  async evaluate(request: PromotionEligibilityRequestV1): Promise<PromotionEligibilityResultV1> {
    const startedAtMs = this.options.now().getTime();
    let outcome: 'ALLOWED' | 'REFUSED' | 'ERROR' = 'ERROR';
    try {
      const result = await this.evaluateInner(request);
      outcome = result.eligible ? 'ALLOWED' : 'REFUSED';
      return result;
    } finally {
      this.sloMetrics.record('eligibility_evaluation_latency_ms', this.options.now().getTime() - startedAtMs, {
        cycleId: request.cycleId,
        environment: request.environment,
        outcome,
      });
    }
  }

  private async evaluateInner(
    request: PromotionEligibilityRequestV1,
  ): Promise<PromotionEligibilityResultV1> {
    const domain = request.domain ?? 'defense_budget';
    const blocks: { reason: PromotionEligibilityBlockReasonV1; detail: string }[] = [];

    const [
      certifications,
      candidates,
      projectionPlans,
      openConflicts,
      unsupported,
      activeSnapshot,
    ] = await Promise.all([
      this.repository.loadCycleCertifications(request.cycleId, request.fiscalYear),
      this.repository.loadCandidates(request.cycleId, request.families),
      this.repository.loadProjectionPlans(request.cycleId, request.families),
      this.repository.countOpenBlockingConflicts(request.cycleId, request.families),
      this.repository.countUnsupportedProjections(request.cycleId, request.families),
      this.repository.loadActiveSnapshot(domain, request.environment),
    ]);

    /* -- Cycle certification -------------------------------------- */
    const certified = certifications.filter((c) => c.status.startsWith('CERTIFIED'));
    if (certifications.length === 0) {
      blocks.push({
        reason: 'cycle_certification_missing',
        detail: `no cycle certification exists for ${request.cycleId} FY${request.fiscalYear}`,
      });
    } else if (certified.length === 0) {
      blocks.push({
        reason: 'cycle_certification_not_certified',
        detail: `cycle ${request.cycleId} has certifications but none is CERTIFIED`,
      });
    }

    /* -- Candidates ------------------------------------------------ */
    const usable: TrustedCandidateRecordV1[] = [];
    for (const candidate of candidates) {
      if (candidate.status === 'SUPERSEDED') {
        blocks.push({
          reason: 'candidate_superseded',
          detail: `candidate ${candidate.candidateId} is SUPERSEDED`,
        });
        continue;
      }
      if (!TERMINAL_PROMOTABLE_STATUSES.has(candidate.status)) {
        blocks.push({
          reason: 'candidate_not_terminal',
          detail: `candidate ${candidate.candidateId} is ${candidate.status}, which carries no promotion implication`,
        });
        continue;
      }
      if (candidate.terminalVerificationRunId == null) {
        blocks.push({
          reason: 'candidate_not_terminal',
          detail: `candidate ${candidate.candidateId} has no terminal verification run`,
        });
        continue;
      }
      if (candidate.status === 'REVIEW_ACCEPTED' && candidate.reviewDecisionId == null) {
        blocks.push({
          reason: 'review_decision_missing',
          detail: `candidate ${candidate.candidateId} is REVIEW_ACCEPTED with no review decision`,
        });
        continue;
      }
      if (candidate.acceptedAssertionIds.length === 0) {
        blocks.push({
          reason: 'assertion_not_accepted',
          detail: `candidate ${candidate.candidateId} has no accepted assertions`,
        });
        continue;
      }
      // Phase 7 Gap 5 decision 2. Blocked here, with its own reason, rather
      // than left to fail the record's schema refinement later: a zod failure
      // surfaces as `projection_hash_mismatch`, which would send an operator
      // looking at projection plans for a source-profile problem.
      if (
        familyRequiresStageSourceProfileV1(candidate.family) &&
        candidate.sourceProfileSha256 == null
      ) {
        blocks.push({
          reason: 'source_profile_missing',
          detail:
            `candidate ${candidate.candidateId} is family ${candidate.family}, which is governed ` +
            `by a stage source profile, but no profile hash was recorded for it`,
        });
        continue;
      }

      // A newer terminal run means the result being promoted is stale.
      const latest = await this.repository.loadLatestTerminalRunId(candidate.candidateId);
      if (latest != null && latest !== candidate.terminalVerificationRunId) {
        blocks.push({
          reason: 'newer_terminal_run_exists',
          detail: `candidate ${candidate.candidateId} has a newer terminal run ${latest}`,
        });
        continue;
      }

      usable.push(candidate);
    }

    if (candidates.length === 0) {
      blocks.push({
        reason: 'candidate_not_terminal',
        detail: `no verified candidates exist in scope for ${request.cycleId}`,
      });
    }

    /* -- Counters -------------------------------------------------- */
    if (openConflicts > 0) {
      blocks.push({
        reason: 'open_blocking_conflict',
        detail: `${openConflicts} open blocking conflict(s) in scope`,
      });
    }
    if (unsupported > 0) {
      blocks.push({
        reason: 'unsupported_mapping',
        detail: `${unsupported} projection item(s) have no canonical mapping`,
      });
    }
    if (projectionPlans.length === 0) {
      blocks.push({
        reason: 'projection_hash_mismatch',
        detail: `no verified projection plan exists for ${request.cycleId}`,
      });
    }

    /* -- Build the record ------------------------------------------ */
    // Anything already blocking means the record cannot be trusted to describe
    // a promotable state, so it is not built and no hash is produced. A refusal
    // never yields an eligibility hash an authorization could bind to.
    if (blocks.length > 0 || usable.length === 0) {
      const result: PromotionEligibilityResultV1 = {
        eligible: false,
        eligibility: null,
        eligibilityHash: null,
        decision: null,
        blocks:
          blocks.length > 0
            ? blocks
            : [
                {
                  reason: 'candidate_not_terminal',
                  detail: 'no candidate survived eligibility filtering',
                },
              ],
      };
      await this.recordAttempt(request, result, domain, activeSnapshot);
      return result;
    }

    const parsed = defenseBudgetPromotionEligibilityV1Schema.safeParse({
      // The constant, not a repeated literal: this exact drift is what made a
      // schema-version bump fail as `projection_hash_mismatch` instead of as a
      // version mismatch.
      schemaVersion: DEFENSE_BUDGET_PROMOTION_ELIGIBILITY_SCHEMA_VERSION,
      eligibilityId: this.options.eligibilityId(request),
      cycleId: request.cycleId,
      scope: {
        cycleId: request.cycleId,
        fiscalYear: request.fiscalYear,
        families: request.families,
        stages: request.stages ?? [],
      },
      projectionPlanIds: projectionPlans.map((p) => p.projectionPlanId),
      projectionPlanHashes: projectionPlans.map((p) => p.contentSha256),
      mappingRegistryVersion: DEFENSE_BUDGET_CANONICAL_MAPPING_REGISTRY_VERSION,
      mappingRegistryHash: canonicalMappingRegistryHashV1(),
      candidates: usable.map((candidate) => ({
        candidateId: candidate.candidateId,
        status: candidate.status,
        terminalVerificationRunId: candidate.terminalVerificationRunId,
        family: candidate.family,
        extractionMethod: candidate.extractionMethod,
        sourceProfileSha256: candidate.sourceProfileSha256,
        ...(candidate.extractorActorId != null
          ? { extractorActorId: candidate.extractorActorId }
          : {}),
        ...(candidate.reviewDecisionId != null
          ? { reviewDecisionId: candidate.reviewDecisionId }
          : {}),
        ...(candidate.reviewerActorId != null
          ? { reviewerActorId: candidate.reviewerActorId }
          : {}),
        acceptedAssertionIds: candidate.acceptedAssertionIds,
        artifactSha256: candidate.artifactSha256,
        sourceSha256: candidate.sourceSha256,
      })),
      sourceDocumentHashes: usable.map((c) => c.sourceSha256),
      artifactHashes: usable.map((c) => c.artifactSha256),
      manifestHash: usable[0]?.manifestSha256,
      // Only the profiles that genuinely exist. Phase 1–5 candidates contribute
      // nothing here, which is why the record-level array is allowed to be
      // empty; the contract cross-checks this set against the candidates so an
      // omission cannot hide behind the same emptiness.
      sourceProfileHashes: usable
        .map((c) => c.sourceProfileSha256)
        .filter((hash): hash is string => hash != null),
      verificationPolicyHashes: usable.map((c) => c.verificationPolicySha256),
      cycleCertificationIds: certified.map((c) => c.certificationId),
      cycleCertificationHashes: certified.map((c) => c.contentSha256),
      expectedActiveSnapshotId: activeSnapshot?.snapshotId ?? null,
      expectedActiveSnapshotHash: activeSnapshot?.snapshotHash ?? null,
      openConflictCount: openConflicts,
      unsupportedItemCount: unsupported,
      generatedAt: this.options.now().toISOString(),
    });

    if (!parsed.success) {
      const result: PromotionEligibilityResultV1 = {
        eligible: false,
        eligibility: null,
        eligibilityHash: null,
        decision: null,
        blocks: [
          {
            reason: 'projection_hash_mismatch',
            detail: `loaded records do not form a valid eligibility contract: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`,
          },
        ],
      };
      await this.recordAttempt(request, result, domain, activeSnapshot);
      return result;
    }

    const eligibility = parsed.data;
    const decision = evaluatePromotionEligibilityV1(eligibility);
    const result: PromotionEligibilityResultV1 = {
      eligible: decision.eligible,
      eligibility,
      eligibilityHash: decision.eligible ? promotionEligibilityHashV1(eligibility) : null,
      decision,
      blocks: decision.blocks,
    };
    await this.recordAttempt(request, result, domain, activeSnapshot);
    return result;
  }

  private async recordAttempt(
    request: PromotionEligibilityRequestV1,
    result: PromotionEligibilityResultV1,
    domain: string,
    activeSnapshot: TrustedActiveSnapshotRecordV1 | null,
  ): Promise<void> {
    await this.audit.record({
      attemptKind: 'ELIGIBILITY',
      outcome: result.eligible ? 'ALLOWED' : 'REFUSED',
      actorId: request.requestedByActorId ?? null,
      cycleId: request.cycleId,
      scope: {
        domain,
        environment: request.environment,
        fiscalYear: request.fiscalYear,
        families: [...request.families].sort((a, b) => a.localeCompare(b)),
        stages: [...(request.stages ?? [])].sort((a, b) => a.localeCompare(b)),
      },
      eligibilityHash: result.eligibilityHash,
      planId: null,
      planHash: null,
      authorizationId: null,
      expectedActiveSnapshotId: activeSnapshot?.snapshotId ?? null,
      reasons: result.blocks.map((block) => block.reason),
      detail: result.blocks.length > 0 ? result.blocks.map((b) => b.detail).join('; ') : null,
    });
  }
}
