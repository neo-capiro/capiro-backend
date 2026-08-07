/**
 * Phase 7 Workstream E — the Prisma-backed `PromotionExecutionRepositoryV1`.
 *
 * This is the persistence edge of the promotion engine. The engine itself is
 * deliberately free of Prisma and Nest; all of that coupling lives here, so
 * Phase 8 can relocate the engine and swap this adapter without touching a line
 * of promotion logic.
 *
 * ---------------------------------------------------------------------------
 * Three decisions worth reading before changing anything
 * ---------------------------------------------------------------------------
 *
 * **1. The run lock is session-scoped, not transaction-scoped.**
 *
 * `pg_advisory_xact_lock` releases at COMMIT. Staging deliberately commits in
 * bounded chunks so a large snapshot never sits inside one enormous
 * transaction, so a transaction-scoped lock would be released at the first
 * chunk boundary and the "one promotion per domain/cycle" guarantee would
 * silently evaporate — while still looking correct in code review.
 *
 * The lock therefore uses session-scoped `pg_advisory_lock` on a dedicated
 * `pg.Client` held for the run's lifetime. A pooled Prisma connection cannot be
 * used for this: the pool may hand a later query to a different backend, which
 * would not hold the lock. The dedicated client is opened, locked, and closed
 * around the callback, and `pg_advisory_unlock` is best-effort because closing
 * the connection releases the lock regardless.
 *
 * Note what the lock is and is not. It is defence in depth. The actual
 * correctness guarantees are database constraints: the unique `activation_key`
 * makes activation exactly-once, and the activation trigger's
 * previous-snapshot check makes a concurrent promoter lose with drift. If the
 * lock were removed entirely the system would still be correct, just noisier.
 *
 * **2. "Ambiguous" is a classification, not a certainty.**
 *
 * A commit whose outcome is genuinely unknown looks like a connection failure,
 * not a constraint violation. `classifyActivationError` treats connection-class
 * SQLSTATEs (08xxx), termination (57P01), and driver-level socket errors as
 * ambiguous, and everything else — notably 23xxx integrity violations — as a
 * determinate failure. The engine's response to ambiguity is to read the
 * activation ledger, never to retry, so a false "ambiguous" costs one extra
 * read and a false "determinate" surfaces as an error rather than a double
 * activation. The classification is deliberately biased that way.
 *
 * **3. Staging is idempotent through the unique index, not through a read.**
 *
 * `createMany({ skipDuplicates: true })` compiles to `ON CONFLICT DO NOTHING`
 * against `defense_budget_canonical_row_identity_unique`. A check-then-insert
 * would race; this cannot. The connection must be `capiro_pe_promoter` (or the
 * table owner) or the canonical-row trigger refuses the write — that is the
 * intended failure and this adapter does not try to work around it.
 */
import { Client as PgClient } from 'pg';
import {
  AmbiguousActivationError,
  type ActivationInputV1,
  type ActivationOutcomeV1,
  type CanonicalRowInputV1,
  type PromotionExecutionModeV1,
  type PromotionExecutionRepositoryV1,
  type StoredExecutionActivationV1,
  type StoredExecutionAuthorizationV1,
  type StoredExecutionPlanV1,
  type StoredExecutionRunV1,
  type StoredSnapshotV1,
} from './canonical-promotion-service-v1.js';
import type {
  DefenseBudgetPromotionPlanV1,
  PromotionProjectionInputV1,
} from './promotion-planner-v1.js';
import { sha256Hex } from '../contracts/canonical-json.js';

/* ------------------------------------------------------------------ */
/* Collaborators                                                       */
/* ------------------------------------------------------------------ */

/**
 * The minimum Prisma surface this adapter needs. Declared structurally rather
 * than as `PrismaClient` so a test double is possible and so the dependency
 * stays visible: every delegate listed here is one this adapter actually
 * touches.
 */
export interface PromotionPrismaLikeV1 {
  $transaction<T>(
    fn: (tx: PromotionPrismaLikeV1) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  defenseBudgetCanonicalSnapshot: PrismaDelegateV1;
  defenseBudgetActiveSnapshot: PrismaDelegateV1;
  defenseBudgetPromotionPlan: PrismaDelegateV1;
  defenseBudgetPromotionAuthorization: PrismaDelegateV1;
  defenseBudgetPromotionRun: PrismaDelegateV1;
  defenseBudgetPromotionItem: PrismaDelegateV1;
  defenseBudgetPromotionActivation: PrismaDelegateV1;
  defenseBudgetPromotionOutbox: PrismaDelegateV1;
  defenseBudgetCanonicalRow: PrismaDelegateV1;
  defenseBudgetRollbackRecord: PrismaDelegateV1;
}

export interface PrismaDelegateV1 {
  findUnique(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findFirst(args: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  create(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  createMany(args: Record<string, unknown>): Promise<{ count: number }>;
  update(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateMany(args: Record<string, unknown>): Promise<{ count: number }>;
  upsert(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/**
 * Reloads the verified projections a plan was built from, straight from the
 * Phase 4-6 projection tables.
 *
 * This is a collaborator rather than a method body because reading each
 * family's projection tables is that family's own knowledge, and because the
 * reload has to be a genuine re-read: the engine re-derives every row hash from
 * whatever comes back and refuses the promotion if it no longer matches what
 * was authorized. Returning a cached copy of the plan's own inputs would make
 * that check vacuous.
 */
export interface PromotionProjectionSourceV1 {
  loadForPlan(plan: StoredExecutionPlanV1): Promise<PromotionProjectionInputV1[]>;
}

/** Opens a dedicated connection for the session-scoped advisory lock. */
export type LockConnectionFactoryV1 = () => Promise<PgClient>;

export interface PrismaPromotionRepositoryOptionsV1 {
  /** Bound so an activation transaction can never hang indefinitely. */
  activationTimeoutMs?: number;
  /** Bound on a single staging chunk's transaction. */
  stagingTimeoutMs?: number;
}

const DEFAULT_ACTIVATION_TIMEOUT_MS = 15_000;
const DEFAULT_STAGING_TIMEOUT_MS = 60_000;

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

/** SQLSTATE classes whose outcome after a COMMIT attempt is genuinely unknown. */
const AMBIGUOUS_SQLSTATE_PREFIXES = ['08']; // connection exception
const AMBIGUOUS_SQLSTATES = new Set([
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);
const AMBIGUOUS_MESSAGE_PATTERNS = [
  /connection.*(closed|terminated|reset|lost)/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /server closed the connection/i,
  /Transaction .* has been closed/i,
];

/**
 * Decide whether a failure leaves the transaction's fate unknown.
 *
 * Biased toward reporting ambiguity: the engine answers ambiguity by reading
 * the activation ledger, which is cheap and safe, whereas mistaking an
 * ambiguous commit for a determinate failure is what allows a second
 * activation attempt.
 */
export function isAmbiguousActivationFailureV1(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string') {
    if (AMBIGUOUS_SQLSTATES.has(code)) return true;
    if (AMBIGUOUS_SQLSTATE_PREFIXES.some((prefix) => code.startsWith(prefix))) return true;
    // A constraint violation is a definite, well-understood failure.
    if (code.startsWith('23')) return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return AMBIGUOUS_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/** Stable signed 64-bit key for `pg_advisory_lock` from an arbitrary string. */
export function advisoryLockKeyV1(input: string): bigint {
  // Take the top 63 bits of the digest and keep it positive, so the key is
  // deterministic across processes and fits a bigint parameter.
  const hex = sha256Hex(input).slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`) >> 1n);
}

/* ------------------------------------------------------------------ */
/* The adapter                                                         */
/* ------------------------------------------------------------------ */

export class PrismaPromotionExecutionRepositoryV1 implements PromotionExecutionRepositoryV1 {
  private readonly activationTimeoutMs: number;
  private readonly stagingTimeoutMs: number;

  constructor(
    private readonly prisma: PromotionPrismaLikeV1,
    private readonly projectionSource: PromotionProjectionSourceV1,
    private readonly lockConnectionFactory: LockConnectionFactoryV1,
    options: PrismaPromotionRepositoryOptionsV1 = {},
  ) {
    this.activationTimeoutMs = options.activationTimeoutMs ?? DEFAULT_ACTIVATION_TIMEOUT_MS;
    this.stagingTimeoutMs = options.stagingTimeoutMs ?? DEFAULT_STAGING_TIMEOUT_MS;
  }

  /* ---- Reads --------------------------------------------------- */

  async loadPlan(planId: string): Promise<StoredExecutionPlanV1 | null> {
    const row = await this.prisma.defenseBudgetPromotionPlan.findUnique({ where: { planId } });
    if (row == null) return null;
    return {
      planId: String(row.planId),
      planHash: String(row.planHash),
      eligibilityHash: String(row.eligibilityHash),
      mappingRegistryHash: String(row.mappingRegistryHash),
      mode: row.mode as StoredExecutionPlanV1['mode'],
      proposedSnapshotId: String(row.proposedSnapshotId),
      expectedActiveSnapshotId:
        row.expectedActiveSnapshotId == null ? null : String(row.expectedActiveSnapshotId),
      blockedCount: Number(row.blockedCount),
      plan: row.planDocument as unknown as DefenseBudgetPromotionPlanV1,
    };
  }

  async loadAuthorization(authorizationId: string): Promise<StoredExecutionAuthorizationV1 | null> {
    const row = await this.prisma.defenseBudgetPromotionAuthorization.findUnique({
      where: { authorizationId },
    });
    if (row == null) return null;
    return {
      authorizationId: String(row.authorizationId),
      planId: String(row.planId),
      planHash: String(row.planHash),
      eligibilityHash: String(row.eligibilityHash),
      expectedActiveSnapshotId:
        row.expectedActiveSnapshotId == null ? null : String(row.expectedActiveSnapshotId),
      expiresAt: toIsoString(row.expiresAt),
      consumedAt: row.consumedAt == null ? null : toIsoString(row.consumedAt),
      consumedByRunId: row.consumedByRunId == null ? null : String(row.consumedByRunId),
    };
  }

  async loadProjections(planId: string): Promise<PromotionProjectionInputV1[]> {
    const plan = await this.loadPlan(planId);
    if (plan == null) return [];
    return this.projectionSource.loadForPlan(plan);
  }

  async loadActiveSnapshotId(domain: string, environment: string): Promise<string | null> {
    const row = await this.prisma.defenseBudgetActiveSnapshot.findFirst({
      where: { domain, environment },
    });
    return row == null ? null : String(row.snapshotId);
  }

  async loadSnapshot(snapshotId: string): Promise<StoredSnapshotV1 | null> {
    const row = await this.prisma.defenseBudgetCanonicalSnapshot.findUnique({
      where: { id: snapshotId },
    });
    if (row == null) return null;
    return {
      snapshotId: String(row.id),
      status: String(row.status),
      requiredScopes: toStringArray(row.requiredScopes),
      completedScopes: toStringArray(row.completedScopes),
      snapshotHash: row.snapshotHash == null ? null : String(row.snapshotHash),
    };
  }

  /* ---- Locking --------------------------------------------------- */

  async withDomainCycleLock<T>(lockKey: string, fn: () => Promise<T>): Promise<T> {
    const key = advisoryLockKeyV1(lockKey);
    const client = await this.lockConnectionFactory();
    try {
      // Blocking acquire. A promotion that waits is correct; a promotion that
      // proceeds without the lock is what this is here to prevent.
      await client.query('SELECT pg_advisory_lock($1)', [key.toString()]);
      try {
        return await fn();
      } finally {
        // Best effort: ending the connection releases the lock regardless, so a
        // failure here cannot strand it.
        await client
          .query('SELECT pg_advisory_unlock($1)', [key.toString()])
          .catch(() => undefined);
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /* ---- Run lifecycle --------------------------------------------- */

  async findRunByKey(runKey: string): Promise<StoredExecutionRunV1 | null> {
    const row = await this.prisma.defenseBudgetPromotionRun.findUnique({ where: { runKey } });
    return row == null ? null : toRun(row);
  }

  async createRun(input: {
    runKey: string;
    planId: string;
    planHash: string;
    authorizationId: string;
    snapshotId: string;
    expectedActiveSnapshotId: string | null;
    executorIdentity: string;
    executionMode: PromotionExecutionModeV1;
  }): Promise<StoredExecutionRunV1> {
    const row = await this.prisma.defenseBudgetPromotionRun.create({
      data: {
        runKey: input.runKey,
        planId: input.planId,
        planHash: input.planHash,
        authorizationId: input.authorizationId,
        snapshotId: input.snapshotId,
        expectedActiveSnapshotId: input.expectedActiveSnapshotId,
        executorIdentity: input.executorIdentity,
        executionMode: input.executionMode,
        status: 'STAGING',
      },
    });
    return toRun(row);
  }

  async updateRunStatus(
    runId: string,
    status: string,
    patch: { failureReason?: string; stagedRowCount?: number } = {},
  ): Promise<void> {
    await this.prisma.defenseBudgetPromotionRun.update({
      where: { id: runId },
      data: {
        status,
        ...(patch.failureReason != null ? { failureReason: patch.failureReason } : {}),
        ...(patch.stagedRowCount != null ? { stagedRowCount: patch.stagedRowCount } : {}),
        ...(status === 'FAILED_PRECOMMIT' ? { failedAt: new Date() } : {}),
      },
    });
  }

  /* ---- Staging ---------------------------------------------------- */

  async loadStagedRowHashes(snapshotId: string): Promise<Map<string, string>> {
    // Scoped by snapshot, not by run. `ON CONFLICT DO NOTHING` skips rows an
    // earlier abandoned run left in this snapshot; if those rows were invisible
    // here the pre-activation proof would refuse every one of them and, since
    // no role holds DELETE, the snapshot could never be completed.
    const rows = await this.prisma.defenseBudgetCanonicalRow.findMany({
      where: { snapshotId },
      select: { canonicalEntity: true, canonicalNaturalKey: true, canonicalRowHash: true },
    });
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(
        `${String(row.canonicalEntity)} ${String(row.canonicalNaturalKey)}`,
        String(row.canonicalRowHash),
      );
    }
    return map;
  }

  async stageRows(rows: CanonicalRowInputV1[]): Promise<void> {
    if (rows.length === 0) return;
    // ON CONFLICT DO NOTHING against defense_budget_canonical_row_identity_unique.
    // Idempotent by construction, so a retried chunk cannot duplicate and cannot
    // race a concurrent writer of the same identity.
    await this.prisma.$transaction(
      async (tx) => {
        await tx.defenseBudgetCanonicalRow.createMany({
          data: rows.map((row) => ({
            snapshotId: row.snapshotId,
            promotionRunId: row.promotionRunId,
            canonicalEntity: row.canonicalEntity,
            canonicalNaturalKey: row.canonicalNaturalKey,
            parentNaturalKey: row.parentNaturalKey,
            family: row.family,
            fiscalYear: row.fiscalYear,
            fundingField: row.fundingField,
            stage: row.stage,
            canonicalRowHash: row.canonicalRowHash,
            moneyOriginalValue: row.moneyOriginalValue,
            moneyOriginalUnit: row.moneyOriginalUnit,
            // Decimal columns accept the exact decimal string. Never a number:
            // passing a JS number here is precisely how float error would enter
            // canonical money.
            moneyValueMillions: row.moneyValueMillions,
            quantity: row.quantity,
            unitCostDollars: row.unitCostDollars,
            textValue: row.textValue,
            dateValue: row.dateValue == null ? null : new Date(row.dateValue),
            attributes: row.attributes,
            directOrDerived: row.directOrDerived,
            bindingStatus: row.bindingStatus,
            sourceProjectionId: row.sourceProjectionId,
            sourceAssertionId: row.sourceAssertionId,
            evidenceIds: row.evidenceIds,
            artifactId: row.artifactId,
            artifactContentSha256: row.artifactContentSha256,
            verificationCandidateId: row.verificationCandidateId,
            verificationRunId: row.verificationRunId,
            sourceDocumentId: row.sourceDocumentId,
            sourcePdfSha256: row.sourcePdfSha256,
            mappingRegistryHash: row.mappingRegistryHash,
            enactmentProofId: row.enactmentProofId,
          })),
          skipDuplicates: true,
        });
      },
      { timeout: this.stagingTimeoutMs },
    );
  }

  async recordPlanItemsStaged(runId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.prisma.defenseBudgetPromotionItem.updateMany({
      where: {
        runId,
        OR: keys.map((key) => {
          const separator = key.indexOf(' ');
          return {
            canonicalEntity: key.slice(0, separator),
            canonicalNaturalKey: key.slice(separator + 1),
          };
        }),
      },
      data: { stagedAt: new Date() },
    });
  }

  async markScopesComplete(snapshotId: string, scopes: string[]): Promise<void> {
    await this.prisma.defenseBudgetCanonicalSnapshot.update({
      where: { id: snapshotId },
      data: { completedScopes: scopes, updatedAt: new Date() },
    });
  }

  /**
   * Pause and resume the Workstream L drainer.
   *
   * L does not exist yet, so there is nothing to signal. These are honest
   * no-ops rather than absent methods: the port exists and `rollback()` calls
   * it in the correct place, so when the drainer is built it has a defined
   * contract to honour instead of a rollback path that never considered it.
   */
  async pauseSideEffectDrain(): Promise<void> {
    /* Workstream L owns the drainer; nothing to pause yet. */
  }

  async resumeSideEffectDrain(): Promise<void> {
    /* Workstream L owns the drainer; nothing to resume yet. */
  }

  async recordRollback(input: {
    rollbackKey: string;
    fromSnapshotId: string;
    toSnapshotId: string;
    authorizationId: string;
    activationId: string;
    reason: string;
    createdBy: string;
  }): Promise<void> {
    await this.prisma.defenseBudgetRollbackRecord.create({
      data: {
        rollbackKey: input.rollbackKey,
        fromSnapshotId: input.fromSnapshotId,
        toSnapshotId: input.toSnapshotId,
        authorizationId: input.authorizationId,
        activationId: input.activationId,
        reason: input.reason,
        createdBy: input.createdBy,
      },
    });
  }

  async markSnapshotReady(snapshotId: string, snapshotHash: string): Promise<void> {
    await this.prisma.defenseBudgetCanonicalSnapshot.update({
      where: { id: snapshotId },
      data: { status: 'READY', snapshotHash, updatedAt: new Date() },
    });
  }

  /* ---- Activation -------------------------------------------------- */

  async findActivationByKey(activationKey: string): Promise<StoredExecutionActivationV1 | null> {
    const row = await this.prisma.defenseBudgetPromotionActivation.findUnique({
      where: { activationKey },
    });
    if (row == null) return null;
    return {
      activationId: String(row.id),
      activationKey: String(row.activationKey),
      newSnapshotId: String(row.newSnapshotId),
      previousSnapshotId: row.previousSnapshotId == null ? null : String(row.previousSnapshotId),
    };
  }

  /**
   * The single small activation transaction. Seven steps, in this order,
   * matching Workstream E.7:
   *
   *   1. lock the active-snapshot row
   *   2. recheck the expected previous snapshot
   *   3. mark the new snapshot active
   *   4. mark the prior snapshot superseded
   *   5. record the activation
   *   6. write the promotion outbox rows
   *   7. mark the authorization used and the run committed
   *
   * Nothing else belongs here. No delta computation, no alert emission, no
   * cache refresh, no compatibility rebuild — a downstream dependency inside
   * this transaction would make canonical commit depend on downstream
   * availability, which is the thing Phase 7 exists to prevent.
   */
  async activate(input: ActivationInputV1): Promise<ActivationOutcomeV1> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          /* 1. Lock the pointer row. Serializes concurrent activations even if
           *    the advisory lock was never taken. */
          await tx.$queryRawUnsafe(
            'SELECT id FROM "defense_budget_active_snapshot" WHERE "domain" = $1 AND "environment" = $2 FOR UPDATE',
            input.domain,
            input.environment,
          );

          /* 2. Recheck the expected previous snapshot under the lock. */
          const pointer = await tx.defenseBudgetActiveSnapshot.findFirst({
            where: { domain: input.domain, environment: input.environment },
          });
          const livePrevious = pointer == null ? null : String(pointer.snapshotId);
          if (livePrevious !== input.previousSnapshotId) {
            throw new PromotionActivationDriftError(
              `expected ${input.previousSnapshotId ?? '(none)'} to be active, found ${livePrevious ?? '(none)'}`,
            );
          }

          /* 2b. A rollback target is SUPERSEDED — that is what step 4 of the
           *     original promotion set it to. `enforce_active_snapshot_preconditions`
           *     admits only READY or ACTIVE, so without this the rollback
           *     transaction aborts with 0A000 and rollback is unavailable at
           *     exactly the moment it exists for. Promoting it back to READY
           *     here, inside the same transaction, is the transition the
           *     trigger is waiting for. The service has already refused any
           *     target that was never activated. */
          if (input.activationKind === 'ROLLBACK') {
            await tx.defenseBudgetCanonicalSnapshot.update({
              where: { id: input.newSnapshotId },
              data: { status: 'READY', updatedAt: new Date() },
            });
          }

          /* 5. Record the activation first: its unique key is what makes this
           *    exactly-once, so it must be the row that loses a race. */
          const activation = await tx.defenseBudgetPromotionActivation.create({
            data: {
              activationKey: input.activationKey,
              runId: input.runId,
              domain: input.domain,
              environment: input.environment,
              previousSnapshotId: input.previousSnapshotId,
              newSnapshotId: input.newSnapshotId,
              authorizationId: input.authorizationId,
              activationKind: input.activationKind,
              activatedBy: input.activatedBy,
            },
          });
          const activationId = String(activation.id);

          /* 3. Move the pointer. */
          if (pointer == null) {
            await tx.defenseBudgetActiveSnapshot.create({
              data: {
                domain: input.domain,
                environment: input.environment,
                snapshotId: input.newSnapshotId,
                activationId,
              },
            });
          } else {
            await tx.defenseBudgetActiveSnapshot.update({
              where: { id: String(pointer.id) },
              data: { snapshotId: input.newSnapshotId, activationId, updatedAt: new Date() },
            });
          }

          /* 3b. Mark the new snapshot active. */
          await tx.defenseBudgetCanonicalSnapshot.update({
            where: { id: input.newSnapshotId },
            data: { status: 'ACTIVE', activatedAt: new Date(), updatedAt: new Date() },
          });

          /* 4. Mark the prior snapshot superseded — never deleted. */
          if (input.previousSnapshotId != null) {
            await tx.defenseBudgetCanonicalSnapshot.update({
              where: { id: input.previousSnapshotId },
              data: {
                status: input.activationKind === 'ROLLBACK' ? 'ROLLED_BACK' : 'SUPERSEDED',
                supersededAt: new Date(),
                updatedAt: new Date(),
              },
            });
          }

          /* 6. Outbox rows, inside the same transaction. */
          if (input.outbox.length > 0) {
            await tx.defenseBudgetPromotionOutbox.createMany({
              data: input.outbox.map((row) => ({
                activationId,
                dedupeKey: row.dedupeKey,
                oldSnapshotId: row.oldSnapshotId,
                newSnapshotId: row.newSnapshotId,
                canonicalEntity: row.canonicalEntity,
                canonicalNaturalKey: row.canonicalNaturalKey,
                family: row.family,
                fiscalYear: row.fiscalYear,
                fundingField: row.fundingField,
                stage: row.stage,
                oldOriginalValue: row.oldOriginalValue,
                oldValueMillions: row.oldValueMillions,
                newOriginalValue: row.newOriginalValue,
                newValueMillions: row.newValueMillions,
                changeClassification: row.changeClassification,
                suppressAlert: row.suppressAlert,
                isCorrection: row.isCorrection,
                isRollback: row.isRollback,
                sourceLineage: row.sourceLineage,
              })),
              skipDuplicates: true,
            });
          }

          /* 7. Consume the authorization and commit the run. The append-only
           *    trigger permits exactly this transition and nothing else. */
          await tx.defenseBudgetPromotionAuthorization.update({
            where: { authorizationId: input.authorizationId },
            data: { consumedAt: new Date(), consumedByRunId: input.runId },
          });
          await tx.defenseBudgetPromotionRun.update({
            where: { id: input.runId },
            data: { status: 'COMMITTED', committedAt: new Date() },
          });

          return {
            activationId,
            previousSnapshotId: input.previousSnapshotId,
            newSnapshotId: input.newSnapshotId,
          };
        },
        { timeout: this.activationTimeoutMs },
      );
    } catch (error) {
      if (isAmbiguousActivationFailureV1(error)) {
        throw new AmbiguousActivationError(input.activationKey);
      }
      throw error;
    }
  }
}

/** The live pointer is not what the activation expected to supersede. */
export class PromotionActivationDriftError extends Error {
  constructor(message: string) {
    super(`active-snapshot drift: ${message}`);
    this.name = 'PromotionActivationDriftError';
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toRun(row: Record<string, unknown>): StoredExecutionRunV1 {
  return {
    runId: String(row.id),
    runKey: String(row.runKey),
    status: String(row.status),
    snapshotId: String(row.snapshotId),
    stagedRowCount: Number(row.stagedRowCount ?? 0),
  };
}

function toIsoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}
