/**
 * Phase 7 Workstream E â€” `DefenseBudgetCanonicalPromotionServiceV1`.
 *
 * The only service allowed to stage and activate a canonical snapshot.
 *
 * Most of the safety already lives in the database. Workstream D put activation
 * preconditions, one-use authorization, plan-hash matching, blocked-plan
 * refusal, row immutability, and the writer-role boundary into constraints and
 * triggers. This service's job is to drive those correctly and fail cleanly
 * when they fire â€” never to re-implement them in TypeScript and never to work
 * around them.
 *
 * The shape of the work:
 *
 * ```text
 *   reload everything from persistence
 *          â†“
 *   refuse on any mismatch (plan hash, authorization, drift, blocked items)
 *          â†“
 *   stage in deterministic, idempotent, hash-verified chunks   â† invisible
 *          â†“
 *   pre-activation proof                                        â† still invisible
 *          â†“
 *   ONE small activation transaction                            â† becomes visible
 *          â†“
 *   side effects drain afterwards, separately                   â† WS L
 * ```
 *
 * Three properties are worth stating explicitly because they are easy to lose:
 *
 * 1. **Nothing here trusts its caller.** The request names a plan, an
 *    authorization, and the hashes it expects. Every one of those is reloaded
 *    and compared; a caller cannot supply a plan body, a row, or a hash that
 *    becomes truth.
 * 2. **Staging is invisible and resumable.** Staged rows belong to a `STAGING`
 *    snapshot, which product reads never select and which the canonical-row
 *    trigger is the only state that permits writes to. A retry re-derives every
 *    row hash and refuses if a previously staged row disagrees, so a resumed
 *    run cannot silently blend two different plans.
 * 3. **An ambiguous commit is resolved by reading, not by retrying.** If the
 *    activation transaction's outcome is unknown, the service reads the
 *    activation ledger by its deterministic key. Blind retry is what turns one
 *    activation into two.
 *
 * Service-neutral: no Nest, no Prisma, no clock of its own. Everything comes
 * through ports and an injected `now`, so Phase 8 can relocate this module and
 * tests can drive it with in-memory fakes.
 */
import {
  proposedRowHashV1,
  type DefenseBudgetPromotionPlanV1,
  type PromotionModeV1,
  type PromotionPlanItemV1,
  type PromotionProjectionInputV1,
} from './promotion-planner-v1.js';
import {
  lookupCanonicalMappingV1,
  parentEntityOfV1,
  type CanonicalEntityV1,
} from './canonical-mapping-registry-v1.js';
import { sha256Hex } from '../contracts/canonical-json.js';
import type { PromotionAuditSinkV1 } from './promotion-eligibility-service-v1.js';
import type { BudgetFamilyV1, FundingFieldV1 } from '../contracts/extraction-artifact-v1.js';
import type { StageV1 } from '../stages/stage-vocabulary-v1.js';

/* ------------------------------------------------------------------ */
/* E1. Request                                                         */
/* ------------------------------------------------------------------ */

export const PROMOTION_EXECUTION_MODE_V1_VALUES = ['execute', 'dry_run', 'resume'] as const;
export type PromotionExecutionModeV1 = (typeof PROMOTION_EXECUTION_MODE_V1_VALUES)[number];

export interface PromotionExecutionRequestV1 {
  planId: string;
  authorizationId: string;
  /** What the caller believes the plan hashes to. Compared, never trusted. */
  expectedPlanHash: string;
  expectedActiveSnapshotId: string | null;
  executorIdentity: string;
  executionMode: PromotionExecutionModeV1;
  domain?: string;
  environment: string;
}

/* ------------------------------------------------------------------ */
/* E2. Records reloaded from persistence                               */
/* ------------------------------------------------------------------ */

export interface StoredExecutionPlanV1 {
  planId: string;
  planHash: string;
  eligibilityHash: string;
  mappingRegistryHash: string;
  mode: PromotionModeV1;
  proposedSnapshotId: string;
  expectedActiveSnapshotId: string | null;
  blockedCount: number;
  plan: DefenseBudgetPromotionPlanV1;
}

export interface StoredExecutionAuthorizationV1 {
  authorizationId: string;
  planId: string;
  planHash: string;
  eligibilityHash: string;
  expectedActiveSnapshotId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  consumedByRunId: string | null;
}

export interface StoredExecutionRunV1 {
  runId: string;
  runKey: string;
  status: string;
  snapshotId: string;
  stagedRowCount: number;
}

export interface StoredExecutionActivationV1 {
  activationId: string;
  activationKey: string;
  newSnapshotId: string;
  previousSnapshotId: string | null;
}

export interface StoredSnapshotV1 {
  snapshotId: string;
  status: string;
  requiredScopes: string[];
  completedScopes: string[];
  snapshotHash: string | null;
}

/* ------------------------------------------------------------------ */
/* E3. Rows and outbox payloads                                        */
/* ------------------------------------------------------------------ */

export interface CanonicalRowInputV1 {
  snapshotId: string;
  promotionRunId: string;
  canonicalEntity: CanonicalEntityV1;
  canonicalNaturalKey: string;
  parentNaturalKey: string | null;
  family: BudgetFamilyV1;
  fiscalYear: number | null;
  fundingField: FundingFieldV1 | null;
  stage: StageV1 | null;
  canonicalRowHash: string;
  moneyOriginalValue: string | null;
  moneyOriginalUnit: string | null;
  moneyValueMillions: string | null;
  quantity: string | null;
  unitCostDollars: string | null;
  textValue: string | null;
  dateValue: string | null;
  attributes: Record<string, string | boolean | null>;
  directOrDerived: string;
  bindingStatus: string;
  sourceProjectionId: string;
  sourceAssertionId: string;
  evidenceIds: string[];
  artifactId: string;
  artifactContentSha256: string;
  verificationCandidateId: string;
  verificationRunId: string;
  sourceDocumentId: string;
  sourcePdfSha256: string;
  mappingRegistryHash: string;
  enactmentProofId: string | null;
}

export const OUTBOX_CLASSIFICATION_V1_VALUES = [
  'initial_hydration',
  'material_change',
  'correction',
  'rollback',
  'unchanged',
  'identity_change',
] as const;
export type OutboxClassificationV1 = (typeof OUTBOX_CLASSIFICATION_V1_VALUES)[number];

export interface PromotionOutboxRowInputV1 {
  dedupeKey: string;
  oldSnapshotId: string | null;
  newSnapshotId: string;
  canonicalEntity: CanonicalEntityV1;
  canonicalNaturalKey: string;
  family: BudgetFamilyV1;
  fiscalYear: number | null;
  fundingField: FundingFieldV1 | null;
  stage: StageV1 | null;
  oldOriginalValue: string | null;
  oldValueMillions: string | null;
  newOriginalValue: string | null;
  newValueMillions: string | null;
  changeClassification: OutboxClassificationV1;
  suppressAlert: boolean;
  isCorrection: boolean;
  isRollback: boolean;
  sourceLineage: Record<string, unknown>;
}

export interface ActivationInputV1 {
  activationKey: string;
  runId: string;
  domain: string;
  environment: string;
  previousSnapshotId: string | null;
  newSnapshotId: string;
  authorizationId: string;
  activationKind: 'PROMOTION' | 'ROLLBACK';
  activatedBy: string;
  outbox: PromotionOutboxRowInputV1[];
}

export interface ActivationOutcomeV1 {
  activationId: string;
  previousSnapshotId: string | null;
  newSnapshotId: string;
}

/**
 * Thrown by a repository when an activation transaction's outcome could not be
 * determined â€” a connection drop after COMMIT was sent, for example. The
 * service responds by reading the activation ledger, never by retrying.
 */
export class AmbiguousActivationError extends Error {
  constructor(
    readonly activationKey: string,
    message = `activation ${activationKey} returned an ambiguous result`,
  ) {
    super(message);
    this.name = 'AmbiguousActivationError';
  }
}

/* ------------------------------------------------------------------ */
/* E4. Ports                                                           */
/* ------------------------------------------------------------------ */

export interface PromotionExecutionRepositoryV1 {
  loadPlan(planId: string): Promise<StoredExecutionPlanV1 | null>;
  loadAuthorization(authorizationId: string): Promise<StoredExecutionAuthorizationV1 | null>;
  /** The verified projections the plan was built from, reloaded. */
  loadProjections(planId: string): Promise<PromotionProjectionInputV1[]>;
  loadActiveSnapshotId(domain: string, environment: string): Promise<string | null>;
  loadSnapshot(snapshotId: string): Promise<StoredSnapshotV1 | null>;

  /** One advisory lock per domain/cycle for the duration of `fn`. */
  withDomainCycleLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T>;

  findRunByKey(runKey: string): Promise<StoredExecutionRunV1 | null>;
  createRun(input: {
    runKey: string;
    planId: string;
    planHash: string;
    authorizationId: string;
    snapshotId: string;
    expectedActiveSnapshotId: string | null;
    executorIdentity: string;
    executionMode: PromotionExecutionModeV1;
  }): Promise<StoredExecutionRunV1>;
  updateRunStatus(
    runId: string,
    status: string,
    patch?: { failureReason?: string; stagedRowCount?: number },
  ): Promise<void>;

  /**
   * Canonical natural key -> row hash for rows already staged into this
   * SNAPSHOT, by any run.
   *
   * Scoped by snapshot rather than by run on purpose. Staging is idempotent
   * through `ON CONFLICT DO NOTHING` on a snapshot-scoped unique index, so rows
   * left behind by an earlier abandoned run are silently skipped on re-insert.
   * If this were scoped by run they would also be invisible to the pre-activation
   * proof, which would then refuse every one of them as `unaccounted_plan_item`
   * â€” and since no role holds DELETE, the snapshot would be permanently stuck.
   */
  loadStagedRowHashes(snapshotId: string): Promise<Map<string, string>>;
  /** Idempotent: inserting an already-present identity must not duplicate. */
  stageRows(rows: CanonicalRowInputV1[]): Promise<void>;
  recordPlanItemsStaged(runId: string, keys: string[]): Promise<void>;

  markScopesComplete(snapshotId: string, scopes: string[]): Promise<void>;
  markSnapshotReady(snapshotId: string, snapshotHash: string): Promise<void>;

  /** The single small activation transaction. */
  activate(input: ActivationInputV1): Promise<ActivationOutcomeV1>;
  findActivationByKey(activationKey: string): Promise<StoredExecutionActivationV1 | null>;

  /**
   * Pause the Workstream L side-effect drainer before a rollback (plan E.10,
   * first bullet).
   *
   * Without this, a drainer mid-flight keeps publishing the rolled-back
   * snapshot's material_change rows AFTER the pointer has moved back, so
   * downstream consumers receive alerts for data that is no longer active —
   * arriving after the rollback's own suppressed marker row.
   *
   * `context` is required rather than convenient. A paused drain is an
   * operational stop that someone will eventually find and want to lift, and a
   * pause row that cannot say who set it or why leaves that person choosing
   * between resuming blind and leaving side effects stalled.
   */
  pauseSideEffectDrain(
    domain: string,
    environment: string,
    context: { reason: string; actor: string },
  ): Promise<void>;
  resumeSideEffectDrain(
    domain: string,
    environment: string,
    context: { actor: string },
  ): Promise<void>;

  /** Append-only rollback ledger entry. */
  recordRollback(input: {
    rollbackKey: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    authorizationId: string;
    activationId: string;
    reason: string;
    createdBy: string;
  }): Promise<void>;
}

export interface PromotionMetricsSinkV1 {
  observe(metric: string, value: number, tags?: Record<string, string>): void;
}

export interface PromotionServiceOptionsV1 {
  now: () => Date;
  /** Rows per staging chunk. Bounded so a transaction never grows unbounded. */
  chunkSize?: number;
  metrics?: PromotionMetricsSinkV1;
}

/* ------------------------------------------------------------------ */
/* E5. Outcomes                                                        */
/* ------------------------------------------------------------------ */

export const PROMOTION_EXECUTION_REFUSAL_V1_VALUES = [
  'plan_not_found',
  'plan_hash_mismatch',
  'plan_has_blocked_items',
  'authorization_not_found',
  'authorization_plan_mismatch',
  'authorization_plan_hash_mismatch',
  'authorization_expired',
  'authorization_already_used',
  'active_snapshot_drift',
  'mapping_registry_drift',
  'projection_missing',
  'projection_hash_mismatch',
  'staged_row_hash_mismatch',
  'unaccounted_plan_item',
  'extra_staged_row',
  'required_scope_incomplete',
  'missing_dependency_row',
  'run_already_committed',
  'run_cancelled',
  'rollback_target_not_eligible',
] as const;
export type PromotionExecutionRefusalV1 = (typeof PROMOTION_EXECUTION_REFUSAL_V1_VALUES)[number];

export interface PromotionExecutionResultV1 {
  committed: boolean;
  runId: string | null;
  snapshotId: string | null;
  activationId: string | null;
  stagedRowCount: number;
  outboxRowCount: number;
  /** True when a prior activation was discovered rather than performed. */
  recoveredExistingActivation: boolean;
  refusals: { reason: PromotionExecutionRefusalV1; detail: string }[];
}

const DEFAULT_CHUNK_SIZE = 500;

/**
 * Statuses a rollback target may hold. A snapshot that was never activated
 * never became truth, and must not become truth by being rolled back to.
 */
const ROLLBACK_ELIGIBLE_TARGET_STATUSES = new Set(['SUPERSEDED', 'ROLLED_BACK', 'ACTIVE']);

const rowKey = (entity: CanonicalEntityV1 | string, naturalKey: string): string =>
  `${entity} ${naturalKey}`;

/* ------------------------------------------------------------------ */
/* E6. The service                                                     */
/* ------------------------------------------------------------------ */

export class DefenseBudgetCanonicalPromotionServiceV1 {
  private readonly chunkSize: number;

  constructor(
    private readonly repository: PromotionExecutionRepositoryV1,
    private readonly audit: PromotionAuditSinkV1,
    private readonly options: PromotionServiceOptionsV1,
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  }

  /**
   * Deterministic run key. The same plan authorized once produces the same run,
   * so a retry resumes rather than starting a second promotion of the same
   * data.
   */
  static runKeyFor(planId: string, authorizationId: string, proposedSnapshotId: string): string {
    return `run:${sha256Hex(`${planId} ${authorizationId} ${proposedSnapshotId}`)}`;
  }

  /** Deterministic activation key â€” the database's exactly-once guarantee. */
  static activationKeyFor(runKey: string, kind: 'PROMOTION' | 'ROLLBACK'): string {
    return `act:${kind.toLowerCase()}:${runKey}`;
  }

  async execute(request: PromotionExecutionRequestV1): Promise<PromotionExecutionResultV1> {
    const domain = request.domain ?? 'defense_budget';
    const started = this.options.now().getTime();

    const plan = await this.repository.loadPlan(request.planId);
    if (plan == null) {
      return this.refuse(request, [
        { reason: 'plan_not_found', detail: `plan ${request.planId} does not exist` },
      ]);
    }

    const lockKey = `${domain}:${plan.plan.scope.cycleId}`;
    return this.repository.withDomainCycleLock(lockKey, async () => {
      const result = await this.executeLocked(request, plan, domain);
      this.options.metrics?.observe(
        'promotion.execute.duration_ms',
        this.options.now().getTime() - started,
        {
          committed: String(result.committed),
        },
      );
      return result;
    });
  }

  private async executeLocked(
    request: PromotionExecutionRequestV1,
    plan: StoredExecutionPlanV1,
    domain: string,
  ): Promise<PromotionExecutionResultV1> {
    const refusals: PromotionExecutionResultV1['refusals'] = [];

    /* ---- Reload and compare every binding (E.3) ---- */

    if (plan.planHash !== request.expectedPlanHash) {
      refusals.push({
        reason: 'plan_hash_mismatch',
        detail: 'the stored plan does not hash to the value the caller expected',
      });
    }
    if (plan.plan.planHash !== plan.planHash) {
      refusals.push({
        reason: 'plan_hash_mismatch',
        detail: 'the stored plan document disagrees with its recorded hash',
      });
    }
    if (plan.blockedCount > 0 || plan.plan.blocked) {
      refusals.push({
        reason: 'plan_has_blocked_items',
        detail: `plan ${plan.planId} has ${plan.blockedCount} blocked item(s)`,
      });
    }

    const authorization = await this.repository.loadAuthorization(request.authorizationId);
    if (authorization == null) {
      refusals.push({
        reason: 'authorization_not_found',
        detail: `authorization ${request.authorizationId} does not exist`,
      });
    } else {
      if (authorization.planId !== plan.planId) {
        refusals.push({
          reason: 'authorization_plan_mismatch',
          detail: `authorization names plan ${authorization.planId}, not ${plan.planId}`,
        });
      }
      if (authorization.planHash !== plan.planHash) {
        refusals.push({
          reason: 'authorization_plan_hash_mismatch',
          detail: 'the plan changed after it was authorized; a new authorization is required',
        });
      }
      if (Date.parse(authorization.expiresAt) <= this.options.now().getTime()) {
        refusals.push({
          reason: 'authorization_expired',
          detail: `authorization expired at ${authorization.expiresAt}`,
        });
      }
    }

    if (refusals.length > 0) return this.refuse(request, refusals);

    const runKey = DefenseBudgetCanonicalPromotionServiceV1.runKeyFor(
      plan.planId,
      request.authorizationId,
      plan.proposedSnapshotId,
    );
    const activationKey = DefenseBudgetCanonicalPromotionServiceV1.activationKeyFor(
      runKey,
      'PROMOTION',
    );

    /* ---- Ambiguous-commit recovery, BEFORE the drift check (E.9) ---- */
    // Order matters here. Once this promotion has activated, the live pointer
    // legitimately no longer equals what the request expected — that is the
    // promotion having succeeded, not drift. Evaluating drift first would
    // refuse every re-execution of an already-committed promotion as
    // active_snapshot_drift, which is exactly the blind-retry loop E.9 exists
    // to prevent: the operator sees a refusal, assumes nothing happened, and
    // tries again. The ledger is consulted first so a completed promotion
    // reports itself as completed.
    const priorActivation = await this.repository.findActivationByKey(activationKey);
    if (priorActivation != null) {
      return {
        committed: true,
        runId: (await this.repository.findRunByKey(runKey))?.runId ?? null,
        snapshotId: priorActivation.newSnapshotId,
        activationId: priorActivation.activationId,
        stagedRowCount: 0,
        outboxRowCount: 0,
        recoveredExistingActivation: true,
        refusals: [],
      };
    }

    /* ---- Drift: only meaningful once we know this run has not committed ---- */
    const actualActive = await this.repository.loadActiveSnapshotId(domain, request.environment);
    if (actualActive !== request.expectedActiveSnapshotId) {
      refusals.push({
        reason: 'active_snapshot_drift',
        detail: `expected active snapshot ${
          request.expectedActiveSnapshotId ?? '(baseline/none)'
        }, found ${actualActive ?? '(baseline/none)'}`,
      });
    }
    if (plan.expectedActiveSnapshotId !== request.expectedActiveSnapshotId) {
      refusals.push({
        reason: 'active_snapshot_drift',
        detail: 'the plan was built against a different expected active snapshot',
      });
    }
    if (refusals.length > 0) return this.refuse(request, refusals);

    // A one-use authorization consumed by a *different* run cannot be reused.
    if (
      authorization?.consumedAt != null &&
      authorization.consumedByRunId !== (await this.repository.findRunByKey(runKey))?.runId
    ) {
      return this.refuse(request, [
        {
          reason: 'authorization_already_used',
          detail: `authorization was consumed at ${authorization.consumedAt}`,
        },
      ]);
    }

    /* ---- Run record: resume or create (E.9) ---- */

    let run = await this.repository.findRunByKey(runKey);
    if (run != null && run.status === 'CANCELLED') {
      return this.refuse(request, [
        { reason: 'run_cancelled', detail: `run ${run.runId} was cancelled` },
      ]);
    }
    if (run != null && (run.status === 'COMMITTED' || run.status === 'COMPLETED')) {
      return this.refuse(request, [
        { reason: 'run_already_committed', detail: `run ${run.runId} is already ${run.status}` },
      ]);
    }
    if (run == null) {
      run = await this.repository.createRun({
        runKey,
        planId: plan.planId,
        planHash: plan.planHash,
        authorizationId: request.authorizationId,
        snapshotId: plan.proposedSnapshotId,
        expectedActiveSnapshotId: request.expectedActiveSnapshotId,
        executorIdentity: request.executorIdentity,
        executionMode: request.executionMode,
      });
    }

    /* ---- Rebuild the authorized row set from reloaded projections ---- */

    const projections = await this.repository.loadProjections(plan.planId);
    const projectionByKey = new Map<string, PromotionProjectionInputV1>();
    for (const projection of projections) {
      const lookup = lookupCanonicalMappingV1(projection.projectionKind);
      if (!lookup.supported) continue;
      projectionByKey.set(rowKey(lookup.entry.canonicalEntity, projection.naturalKey), projection);
    }

    /* A snapshot is a COMPLETE annual picture, not a changeset.
     *
     * `buildExecutionExpectationsV1` deliberately returns only the rows that
     * change â€” it answers "what is this promotion doing". Staging only those
     * would leave the new snapshot holding just the deltas, and because
     * `defense_budget_canonical_row_identity_unique` is scoped by snapshot and
     * there is no lineage column, activating it would make every UNCHANGED row
     * disappear from the active snapshot. Invariant 22 ("one response never
     * mixes snapshots") means a read cannot fall back to the prior snapshot to
     * find them.
     *
     * So the staged set is every non-blocked item, and UNCHANGED rows are
     * carried forward verbatim. They cost a row each and they are what makes
     * the snapshot self-contained. The outbox, by contrast, still excludes them
     * â€” carrying a row forward is not a change and must not notify. */
    const expectations = plan.plan.items
      .filter(
        (item) =>
          item.operation !== 'BLOCKED' &&
          item.canonicalEntity != null &&
          item.proposedRowHash != null,
      )
      .map((item) => ({
        canonicalEntity: item.canonicalEntity as CanonicalEntityV1,
        naturalKey: item.canonicalNaturalKey,
        rowHash: item.proposedRowHash as string,
      }));
    const rows: CanonicalRowInputV1[] = [];

    for (const expectation of expectations) {
      const key = rowKey(expectation.canonicalEntity, expectation.naturalKey);
      const projection = projectionByKey.get(key);
      if (projection == null) {
        refusals.push({
          reason: 'projection_missing',
          detail: `the plan authorizes ${key} but no verified projection was found for it`,
        });
        continue;
      }

      // Re-derive rather than trust: the hash must reproduce from the reloaded
      // projection, otherwise the projection changed after planning.
      const recomputed = proposedRowHashV1({
        canonicalEntity: expectation.canonicalEntity,
        naturalKey: projection.naturalKey,
        fiscalYear: projection.fiscalYear ?? null,
        fundingField: projection.fundingField ?? null,
        values: projection.values,
      });
      if (recomputed !== expectation.rowHash) {
        refusals.push({
          reason: 'projection_hash_mismatch',
          detail: `${key} now hashes to ${recomputed}, not the authorized ${expectation.rowHash}`,
        });
        continue;
      }

      rows.push(
        this.toCanonicalRow(
          projection,
          expectation.canonicalEntity,
          expectation.rowHash,
          plan,
          run.runId,
        ),
      );
    }

    if (refusals.length > 0) {
      await this.repository.updateRunStatus(run.runId, 'FAILED_PRECOMMIT', {
        failureReason: refusals.map((r) => r.detail).join('; '),
      });
      return this.refuse(request, refusals, run.runId);
    }

    /* ---- Stage in deterministic, idempotent, hash-verified chunks (E.5) ---- */

    const alreadyStaged = await this.repository.loadStagedRowHashes(plan.proposedSnapshotId);
    for (const row of rows) {
      const existing = alreadyStaged.get(rowKey(row.canonicalEntity, row.canonicalNaturalKey));
      if (existing != null && existing !== row.canonicalRowHash) {
        refusals.push({
          reason: 'staged_row_hash_mismatch',
          detail: `resumed run has ${row.canonicalNaturalKey} staged with a different hash; the plan changed under it`,
        });
      }
    }
    if (refusals.length > 0) {
      await this.repository.updateRunStatus(run.runId, 'FAILED_PRECOMMIT', {
        failureReason: refusals.map((r) => r.detail).join('; '),
      });
      return this.refuse(request, refusals, run.runId);
    }

    const pending = rows.filter(
      (row) => !alreadyStaged.has(rowKey(row.canonicalEntity, row.canonicalNaturalKey)),
    );
    // Deterministic chunk boundaries: the same plan always chunks the same way,
    // so a resumed run picks up exactly where it stopped.
    pending.sort((a, b) =>
      compareBytewiseV1(
        rowKey(a.canonicalEntity, a.canonicalNaturalKey),
        rowKey(b.canonicalEntity, b.canonicalNaturalKey),
      ),
    );

    for (let index = 0; index < pending.length; index += this.chunkSize) {
      const chunk = pending.slice(index, index + this.chunkSize);
      await this.repository.stageRows(chunk);
      await this.repository.recordPlanItemsStaged(
        run.runId,
        chunk.map((row) => rowKey(row.canonicalEntity, row.canonicalNaturalKey)),
      );
      this.options.metrics?.observe('promotion.staged_rows', chunk.length);
    }

    await this.repository.updateRunStatus(run.runId, 'STAGED', { stagedRowCount: rows.length });

    /* ---- Pre-activation proof (E.6) ---- */

    const staged = await this.repository.loadStagedRowHashes(plan.proposedSnapshotId);
    const authorizedKeys = new Set(
      rows.map((row) => rowKey(row.canonicalEntity, row.canonicalNaturalKey)),
    );

    for (const row of rows) {
      const key = rowKey(row.canonicalEntity, row.canonicalNaturalKey);
      const hash = staged.get(key);
      if (hash == null) {
        refusals.push({ reason: 'unaccounted_plan_item', detail: `${key} was never staged` });
      } else if (hash !== row.canonicalRowHash) {
        refusals.push({
          reason: 'staged_row_hash_mismatch',
          detail: `${key} staged with ${hash}, expected ${row.canonicalRowHash}`,
        });
      }
    }
    for (const key of staged.keys()) {
      if (!authorizedKeys.has(key)) {
        refusals.push({
          reason: 'extra_staged_row',
          detail: `${key} is staged but the authorized plan does not contain it`,
        });
      }
    }

    // Referential integrity: a child row's parent must be staged here or
    // already live in the snapshot lineage the plan diffed against.
    for (const row of rows) {
      if (row.parentNaturalKey == null) continue;
      const parentEntity = parentEntityOfV1(row.canonicalEntity);
      if (parentEntity == null) continue;
      if (!staged.has(rowKey(parentEntity, row.parentNaturalKey))) {
        // The planner already accepted parents that are live rather than
        // staged; only a parent that is neither is a defect here.
        const parentLive = await this.parentIsLive(plan, parentEntity, row.parentNaturalKey);
        if (!parentLive) {
          refusals.push({
            reason: 'missing_dependency_row',
            detail: `${row.canonicalNaturalKey} needs ${parentEntity} "${row.parentNaturalKey}", which is neither staged nor active`,
          });
        }
      }
    }

    const snapshot = await this.repository.loadSnapshot(plan.proposedSnapshotId);
    const requiredScopes = snapshot?.requiredScopes ?? [];
    const coveredScopes = new Set(plan.plan.scope.families as string[]);
    const missingScopes = requiredScopes.filter((scope) => !coveredScopes.has(scope));
    if (missingScopes.length > 0) {
      refusals.push({
        reason: 'required_scope_incomplete',
        detail: `snapshot requires scopes not covered by this plan: ${missingScopes.join(', ')}`,
      });
    }

    if (refusals.length > 0) {
      await this.repository.updateRunStatus(run.runId, 'FAILED_PRECOMMIT', {
        failureReason: refusals.map((r) => r.detail).join('; '),
      });
      return this.refuse(request, refusals, run.runId);
    }

    if (request.executionMode === 'dry_run') {
      await this.repository.updateRunStatus(run.runId, 'READY');
      return {
        committed: false,
        runId: run.runId,
        snapshotId: plan.proposedSnapshotId,
        activationId: null,
        stagedRowCount: rows.length,
        outboxRowCount: 0,
        recoveredExistingActivation: false,
        refusals: [],
      };
    }

    /* ---- Activation: one small transaction (E.7) ---- */

    await this.repository.markScopesComplete(plan.proposedSnapshotId, requiredScopes);
    await this.repository.markSnapshotReady(plan.proposedSnapshotId, snapshotHashFor(plan, rows));
    await this.repository.updateRunStatus(run.runId, 'ACTIVATING');

    const outbox = this.buildOutbox(plan, activationKey, request.expectedActiveSnapshotId);

    let outcome: ActivationOutcomeV1;
    try {
      outcome = await this.repository.activate({
        activationKey,
        runId: run.runId,
        domain,
        environment: request.environment,
        previousSnapshotId: request.expectedActiveSnapshotId,
        newSnapshotId: plan.proposedSnapshotId,
        authorizationId: request.authorizationId,
        activationKind: 'PROMOTION',
        activatedBy: request.executorIdentity,
        outbox,
      });
    } catch (error) {
      // Whatever went wrong, the activation ledger â€” not the exception â€” is the
      // authority on whether the activation happened. Read it before deciding
      // anything. This covers both an ambiguous commit (the transaction
      // succeeded but the caller never learned) and a lost race against a
      // concurrent promoter (the unique activation key rejected the second
      // writer). Retrying blindly is what turns one activation into two.
      const recovered = await this.repository.findActivationByKey(activationKey);
      if (recovered != null) {
        await this.repository.updateRunStatus(run.runId, 'SIDE_EFFECTS_PENDING');
        return {
          committed: true,
          runId: run.runId,
          snapshotId: recovered.newSnapshotId,
          activationId: recovered.activationId,
          stagedRowCount: rows.length,
          outboxRowCount: outbox.length,
          recoveredExistingActivation: true,
          refusals: [],
        };
      }
      await this.repository.updateRunStatus(run.runId, 'FAILED_PRECOMMIT', {
        failureReason:
          error instanceof AmbiguousActivationError
            ? 'activation result ambiguous and no ledger entry exists; not retried'
            : error instanceof Error
              ? error.message
              : String(error),
      });
      throw error;
    }

    // Side effects are deliberately NOT run here. The run is left in
    // SIDE_EFFECTS_PENDING for the Workstream L drainer to pick up; a downstream
    // failure must never be able to undo a committed snapshot.
    await this.repository.updateRunStatus(run.runId, 'SIDE_EFFECTS_PENDING');
    this.options.metrics?.observe('promotion.activated', 1, { snapshot: outcome.newSnapshotId });

    await this.audit.record({
      attemptKind: 'REDEMPTION',
      outcome: 'ALLOWED',
      actorId: request.executorIdentity,
      cycleId: plan.plan.scope.cycleId,
      scope: { environment: request.environment, domain },
      eligibilityHash: plan.eligibilityHash,
      planId: plan.planId,
      planHash: plan.planHash,
      authorizationId: request.authorizationId,
      expectedActiveSnapshotId: request.expectedActiveSnapshotId,
      reasons: [],
      detail: null,
    });

    return {
      committed: true,
      runId: run.runId,
      snapshotId: outcome.newSnapshotId,
      activationId: outcome.activationId,
      stagedRowCount: rows.length,
      outboxRowCount: outbox.length,
      recoveredExistingActivation: false,
      refusals: [],
    };
  }

  /* ---------------------------------------------------------------- */
  /* E7. Rollback                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Reactivate a prior immutable snapshot. This is a forward audited pointer
   * transition: it creates a new activation record and moves the pointer. It
   * deletes nothing, and the database would refuse if it tried.
   */
  async rollback(request: {
    toSnapshotId: string;
    authorizationId: string;
    executorIdentity: string;
    environment: string;
    domain?: string;
    reason: string;
  }): Promise<PromotionExecutionResultV1> {
    const domain = request.domain ?? 'defense_budget';
    return this.repository.withDomainCycleLock(`${domain}:${request.environment}:rollback`, () =>
      this.rollbackLocked(request, domain),
    );
  }

  private async rollbackLocked(
    request: {
      toSnapshotId: string;
      authorizationId: string;
      executorIdentity: string;
      environment: string;
      domain?: string;
      reason: string;
    },
    domain: string,
  ): Promise<PromotionExecutionResultV1> {
    const refusals: PromotionExecutionResultV1['refusals'] = [];
    const currentActive = await this.repository.loadActiveSnapshotId(domain, request.environment);

    const authorization = await this.repository.loadAuthorization(request.authorizationId);
    if (authorization == null) {
      return this.refuseRollback(request, domain, currentActive, [
        {
          reason: 'authorization_not_found',
          detail: `rollback authorization ${request.authorizationId} does not exist`,
        },
      ]);
    }
    if (Date.parse(authorization.expiresAt) <= this.options.now().getTime()) {
      refusals.push({
        reason: 'authorization_expired',
        detail: `rollback authorization expired at ${authorization.expiresAt}`,
      });
    }
    // One-use applies to rollback too. Without this the only enforcement is the
    // database's partial unique index, which fires far later and less clearly.
    if (authorization.consumedAt != null) {
      refusals.push({
        reason: 'authorization_already_used',
        detail: `rollback authorization was consumed at ${authorization.consumedAt}`,
      });
    }
    if (authorization.expectedActiveSnapshotId !== currentActive) {
      refusals.push({
        reason: 'active_snapshot_drift',
        detail: `rollback authorization expected ${
          authorization.expectedActiveSnapshotId ?? '(none)'
        } to be active, found ${currentActive ?? '(none)'}`,
      });
    }

    const target = await this.repository.loadSnapshot(request.toSnapshotId);
    if (target == null) {
      refusals.push({
        reason: 'plan_not_found',
        detail: `rollback target snapshot ${request.toSnapshotId} does not exist`,
      });
    } else if (!ROLLBACK_ELIGIBLE_TARGET_STATUSES.has(target.status)) {
      // A prior snapshot is SUPERSEDED — that is exactly what activation set it
      // to. Only a snapshot that was once real may be reactivated; a STAGING or
      // FAILED one never became truth and must not become truth by rollback.
      refusals.push({
        reason: 'rollback_target_not_eligible',
        detail: `snapshot ${request.toSnapshotId} is ${target.status}; only a previously activated snapshot may be rolled back to`,
      });
    }
    if (request.toSnapshotId === currentActive) {
      refusals.push({
        reason: 'rollback_target_not_eligible',
        detail: 'the rollback target is already the active snapshot',
      });
    }

    if (refusals.length > 0) {
      return this.refuseRollback(request, domain, currentActive, refusals);
    }

    const rollbackKey = `rb:${sha256Hex(
      `${domain} ${request.environment} ${request.authorizationId} ${request.toSnapshotId}`,
    )}`;
    const activationKey = `act:rollback:${rollbackKey}`;

    const existing = await this.repository.findActivationByKey(activationKey);
    if (existing != null) {
      return {
        committed: true,
        runId: null,
        snapshotId: existing.newSnapshotId,
        activationId: existing.activationId,
        stagedRowCount: 0,
        outboxRowCount: 0,
        recoveredExistingActivation: true,
        refusals: [],
      };
    }

    // E.10, first bullet. Pause BEFORE the pointer moves, so the drainer cannot
    // publish the outgoing snapshot's changes after it stops being active.
    await this.repository.pauseSideEffectDrain(domain, request.environment, {
      reason: `rollback to ${request.toSnapshotId}: ${request.reason}`,
      actor: request.executorIdentity,
    });

    // A rollback needs its own run: the activation ledger has a foreign key to
    // a run, and reusing the original promotion run would consume a second
    // authorization under a run id that already consumed one, which the
    // one-use partial unique index refuses.
    const run = await this.repository.createRun({
      runKey: `run:${rollbackKey}`,
      planId: authorization.planId,
      planHash: authorization.planHash,
      authorizationId: request.authorizationId,
      snapshotId: request.toSnapshotId,
      expectedActiveSnapshotId: currentActive,
      executorIdentity: request.executorIdentity,
      executionMode: 'execute',
    });

    const outbox: PromotionOutboxRowInputV1[] = [
      {
        dedupeKey: sha256Hex(`${activationKey} rollback-marker`),
        oldSnapshotId: currentActive,
        newSnapshotId: request.toSnapshotId,
        canonicalEntity: 'canonical_budget_line_source_observation',
        canonicalNaturalKey: `rollback:${request.toSnapshotId}`,
        family: 'unknown',
        fiscalYear: null,
        fundingField: null,
        stage: null,
        oldOriginalValue: null,
        oldValueMillions: null,
        newOriginalValue: null,
        newValueMillions: null,
        changeClassification: 'rollback',
        suppressAlert: true,
        isCorrection: false,
        isRollback: true,
        sourceLineage: { reason: request.reason, rolledBackFrom: currentActive },
      },
    ];

    let outcome: ActivationOutcomeV1;
    try {
      outcome = await this.repository.activate({
        activationKey,
        runId: run.runId,
        domain,
        environment: request.environment,
        previousSnapshotId: currentActive,
        newSnapshotId: request.toSnapshotId,
        authorizationId: request.authorizationId,
        activationKind: 'ROLLBACK',
        activatedBy: request.executorIdentity,
        outbox,
      });
    } catch (error) {
      // Same rule as promotion: the ledger, not the exception, is the authority.
      const recovered = await this.repository.findActivationByKey(activationKey).catch(() => null);
      if (recovered == null) {
        await this.repository.updateRunStatus(run.runId, 'FAILED_PRECOMMIT', {
          failureReason: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      outcome = {
        activationId: recovered.activationId,
        previousSnapshotId: recovered.previousSnapshotId,
        newSnapshotId: recovered.newSnapshotId,
      };
    }

    await this.repository.recordRollback({
      rollbackKey,
      fromSnapshotId: currentActive ?? request.toSnapshotId,
      toSnapshotId: request.toSnapshotId,
      authorizationId: request.authorizationId,
      activationId: outcome.activationId,
      reason: request.reason,
      createdBy: request.executorIdentity,
    });

    await this.repository.updateRunStatus(run.runId, 'SIDE_EFFECTS_PENDING');

    await this.audit.record({
      attemptKind: 'REDEMPTION',
      outcome: 'ALLOWED',
      actorId: request.executorIdentity,
      cycleId: null,
      scope: { environment: request.environment, domain, kind: 'ROLLBACK' },
      eligibilityHash: null,
      planId: authorization.planId,
      planHash: authorization.planHash,
      authorizationId: request.authorizationId,
      expectedActiveSnapshotId: currentActive,
      reasons: [],
      detail: request.reason,
    });

    return {
      committed: true,
      runId: run.runId,
      snapshotId: outcome.newSnapshotId,
      activationId: outcome.activationId,
      stagedRowCount: 0,
      outboxRowCount: outbox.length,
      recoveredExistingActivation: false,
      refusals: [],
    };
  }

  private async refuseRollback(
    request: { authorizationId: string; environment: string; executorIdentity: string },
    domain: string,
    currentActive: string | null,
    refusals: PromotionExecutionResultV1['refusals'],
  ): Promise<PromotionExecutionResultV1> {
    await this.audit.record({
      attemptKind: 'REDEMPTION',
      outcome: 'REFUSED',
      actorId: request.executorIdentity,
      cycleId: null,
      scope: { environment: request.environment, domain, kind: 'ROLLBACK' },
      eligibilityHash: null,
      planId: null,
      planHash: null,
      authorizationId: request.authorizationId,
      expectedActiveSnapshotId: currentActive,
      reasons: refusals.map((refusal) => refusal.reason),
      detail: refusals.map((refusal) => refusal.detail).join('; '),
    });
    return {
      committed: false,
      runId: null,
      snapshotId: null,
      activationId: null,
      stagedRowCount: 0,
      outboxRowCount: 0,
      recoveredExistingActivation: false,
      refusals,
    };
  }

  /* ---------------------------------------------------------------- */
  /* E8. Cancellation â€” only before activation (E.11)                  */
  /* ---------------------------------------------------------------- */

  async cancel(runKey: string, reason: string): Promise<{ cancelled: boolean; detail: string }> {
    const run = await this.repository.findRunByKey(runKey);
    if (run == null) return { cancelled: false, detail: `run ${runKey} does not exist` };
    if (!['STAGING', 'STAGED', 'READY'].includes(run.status)) {
      return {
        cancelled: false,
        detail: `run ${run.runId} is ${run.status}; only a run that has not activated may be cancelled`,
      };
    }
    await this.repository.updateRunStatus(run.runId, 'CANCELLED', { failureReason: reason });
    return { cancelled: true, detail: `run ${run.runId} cancelled` };
  }

  /* ---------------------------------------------------------------- */
  /* helpers                                                           */
  /* ---------------------------------------------------------------- */

  private async parentIsLive(
    plan: StoredExecutionPlanV1,
    parentEntity: CanonicalEntityV1,
    parentNaturalKey: string,
  ): Promise<boolean> {
    // The plan recorded an UNCHANGED item for a parent that is already active.
    return plan.plan.items.some(
      (item) =>
        item.canonicalEntity === parentEntity &&
        item.canonicalNaturalKey === parentNaturalKey &&
        item.operation === 'UNCHANGED',
    );
  }

  private toCanonicalRow(
    projection: PromotionProjectionInputV1,
    entity: CanonicalEntityV1,
    rowHash: string,
    plan: StoredExecutionPlanV1,
    runId: string,
  ): CanonicalRowInputV1 {
    const lookup = lookupCanonicalMappingV1(projection.projectionKind);
    const family = lookup.supported ? lookup.entry.family : 'unknown';
    const money = projection.values.money ?? null;
    return {
      snapshotId: plan.proposedSnapshotId,
      promotionRunId: runId,
      canonicalEntity: entity,
      canonicalNaturalKey: projection.naturalKey,
      parentNaturalKey: projection.parentNaturalKey ?? null,
      family,
      fiscalYear: projection.fiscalYear ?? null,
      fundingField: projection.fundingField ?? null,
      stage: projection.stage ?? null,
      canonicalRowHash: rowHash,
      moneyOriginalValue: money?.originalValue ?? null,
      moneyOriginalUnit: money?.originalUnit ?? null,
      moneyValueMillions: money?.valueMillions ?? null,
      quantity: projection.values.quantity ?? null,
      unitCostDollars: projection.values.unitCostDollars ?? null,
      textValue: projection.values.textValue ?? null,
      dateValue: projection.values.dateValue ?? null,
      attributes: projection.values.attributes ?? {},
      directOrDerived: projection.directOrDerived,
      bindingStatus: projection.bindingStatus === 'accepted' ? 'accepted' : 'not_applicable',
      sourceProjectionId: projection.projectionId,
      sourceAssertionId: projection.lineage.sourceAssertionId,
      evidenceIds: projection.lineage.evidenceIds,
      artifactId: projection.lineage.artifactId,
      artifactContentSha256: projection.lineage.artifactContentSha256,
      verificationCandidateId: projection.lineage.verificationCandidateId,
      verificationRunId: projection.lineage.verificationRunId,
      sourceDocumentId: projection.lineage.sourceDocumentId,
      sourcePdfSha256: projection.lineage.sourcePdfSha256,
      mappingRegistryHash: plan.mappingRegistryHash,
      enactmentProofId: projection.enactmentProofId ?? null,
    };
  }

  /**
   * Outbox payloads, built from the plan and written inside the activation
   * transaction. Classification follows the plan's alert disposition, so the
   * suppression decision made at planning time is the one that reaches the
   * database â€” where a CHECK constraint refuses an un-suppressed hydration,
   * correction, or rollback row regardless.
   */
  private buildOutbox(
    plan: StoredExecutionPlanV1,
    activationKey: string,
    oldSnapshotId: string | null,
  ): PromotionOutboxRowInputV1[] {
    const rows: PromotionOutboxRowInputV1[] = [];
    for (const item of plan.plan.items) {
      if (item.operation === 'BLOCKED' || item.operation === 'UNCHANGED') continue;
      if (item.canonicalEntity == null) continue;

      const classification = classifyOutboxV1(plan.plan.mode, item);
      rows.push({
        dedupeKey: sha256Hex(`${activationKey} ${item.canonicalEntity} ${item.canonicalNaturalKey}`),
        oldSnapshotId,
        newSnapshotId: plan.proposedSnapshotId,
        canonicalEntity: item.canonicalEntity,
        canonicalNaturalKey: item.canonicalNaturalKey,
        family: item.family ?? 'unknown',
        fiscalYear: item.fiscalYear,
        fundingField: item.fundingField,
        stage: null,
        oldOriginalValue: null,
        oldValueMillions: null,
        newOriginalValue: null,
        newValueMillions: null,
        changeClassification: classification,
        suppressAlert: item.alertDisposition !== 'eligible',
        isCorrection: item.operation === 'CORRECTION',
        isRollback: plan.plan.mode === 'rollback',
        sourceLineage: {
          sourceProjectionId: item.sourceProjectionId,
          sourceProjectionHash: item.sourceProjectionHash,
          priorRowHash: item.priorRowHash,
          proposedRowHash: item.proposedRowHash,
        },
      });
    }
    return rows;
  }

  private async refuse(
    request: PromotionExecutionRequestV1,
    refusals: PromotionExecutionResultV1['refusals'],
    runId: string | null = null,
  ): Promise<PromotionExecutionResultV1> {
    await this.audit.record({
      attemptKind: 'REDEMPTION',
      outcome: 'REFUSED',
      actorId: request.executorIdentity,
      cycleId: null,
      scope: { environment: request.environment, domain: request.domain ?? 'defense_budget' },
      eligibilityHash: null,
      planId: request.planId,
      planHash: request.expectedPlanHash,
      authorizationId: request.authorizationId,
      expectedActiveSnapshotId: request.expectedActiveSnapshotId,
      reasons: refusals.map((refusal) => refusal.reason),
      detail: refusals.map((refusal) => refusal.detail).join('; '),
    });
    return {
      committed: false,
      runId,
      snapshotId: null,
      activationId: null,
      stagedRowCount: 0,
      outboxRowCount: 0,
      recoveredExistingActivation: false,
      refusals,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Outbox classification. Run mode dominates: a baseline hydration or a rollback
 * classifies every row that way regardless of what changed, which is what stops
 * a first load of a million rows from reading as a million material changes.
 */
export function classifyOutboxV1(
  mode: PromotionModeV1,
  item: PromotionPlanItemV1,
): OutboxClassificationV1 {
  if (mode === 'baseline_hydration') return 'initial_hydration';
  if (mode === 'rollback') return 'rollback';
  if (item.operation === 'CORRECTION') return 'correction';
  if (item.operation === 'UNCHANGED') return 'unchanged';
  if (item.alertDisposition === 'suppressed_not_alertable') return 'identity_change';
  return 'material_change';
}

/** Byte-wise, locale-independent ordering. Feeds an immutable hash, so it
 * must not depend on ICU data that can differ between promoter hosts. */
export function compareBytewiseV1(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deterministic snapshot hash: the content of the snapshot is exactly the set
 * of canonical row hashes it contains, in sorted order, bound to the plan.
 */
export function snapshotHashFor(
  plan: StoredExecutionPlanV1,
  rows: { canonicalEntity: string; canonicalNaturalKey: string; canonicalRowHash: string }[],
): string {
  const ordered = [...rows]
    .map((row) => `${row.canonicalEntity} ${row.canonicalNaturalKey} ${row.canonicalRowHash}`)
    .sort(compareBytewiseV1);
  return sha256Hex([plan.planHash, plan.proposedSnapshotId, ...ordered].join(''));
}
