/**
 * Phase 7 Workstream L — draining the promotion outbox.
 *
 * Workstream E already did the hard part. Outbox rows are written *inside* the
 * activation transaction, with classification and suppression decided at
 * planning time, and the database refuses an un-suppressed hydration,
 * correction, rollback, or unchanged row regardless of what the application
 * does. A committed run is deliberately left in `SIDE_EFFECTS_PENDING`.
 *
 * This module decides what happens to those rows. It is pure policy over a
 * narrow port: no Prisma, no clock, no timers. Attempt counts and instants
 * arrive as arguments, so every decision here is reproducible in a test — which
 * matters more than usual, because the alternative is asserting on retry
 * behaviour by sleeping.
 *
 * Three properties the rest of Phase 7 depends on:
 *
 * 1. **Canonical commit never depends on any of this.** A drain that fails
 *    forever leaves the snapshot active and the run auditable; it does not
 *    reverse an activation. The worst outcome is
 *    `COMMITTED_WITH_SIDE_EFFECT_FAILURE`, which is a state, not a rollback.
 * 2. **A paused drain claims nothing.** `rollback()` in Workstream E calls
 *    `pauseSideEffectDrain` before moving the pointer. If the drainer ignored
 *    that, a batch already in flight could publish a snapshot's changes after
 *    that snapshot stopped being active — announcing a number that is no longer
 *    true.
 * 3. **A poison row is quarantined, not retried forever and not dropped.** It
 *    keeps its last error and stops consuming batch slots, and it holds the run
 *    out of `COMPLETED` so nobody reads a clean status over a row that never
 *    went anywhere.
 */

/* ------------------------------------------------------------------ */
/* L1. Outcomes                                                        */
/* ------------------------------------------------------------------ */

export const OUTBOX_ROW_STATUS_V1_VALUES = [
  'PENDING',
  'PROCESSING',
  'DONE',
  'FAILED',
  'POISON',
] as const;
export type OutboxRowStatusV1 = (typeof OUTBOX_ROW_STATUS_V1_VALUES)[number];

/**
 * How many times a row is retried before it is quarantined.
 *
 * Deliberately small. A downstream that has refused the same row five times is
 * not going to accept it on the sixth; what it needs is a human, which is what
 * `POISON` plus a backlog alarm produces. Retrying longer only delays the alarm
 * and keeps a doomed row in the batch rotation.
 */
export const OUTBOX_MAX_ATTEMPTS_V1 = 5;

/** Bounded batch. Large enough to make progress, small enough to hold locks briefly. */
export const OUTBOX_DEFAULT_BATCH_SIZE_V1 = 100;

export type DrainFailureDispositionV1 = 'retry' | 'poison';

/**
 * What to do with a row that just failed.
 *
 * `attemptsBefore` is the row's attempt count *before* this failure, which is
 * what the database holds when the drainer reads it. Off-by-one here is the
 * difference between quarantining a row one attempt early and retrying it
 * forever, so the boundary is asserted in both directions in the spec.
 */
export function drainFailureDispositionV1(
  attemptsBefore: number,
  maxAttempts: number = OUTBOX_MAX_ATTEMPTS_V1,
): DrainFailureDispositionV1 {
  return attemptsBefore + 1 >= maxAttempts ? 'poison' : 'retry';
}

/**
 * Backoff before a failed row is eligible again, as milliseconds.
 *
 * Exponential on the attempt count and capped, so a downstream outage does not
 * turn into a hot loop and a long outage does not push the next attempt beyond
 * the point anyone is still watching. Deterministic — no jitter — because the
 * drainer claims rows with `FOR UPDATE SKIP LOCKED`, so concurrent drainers
 * already cannot collide on the same row and jitter would only make the
 * behaviour untestable.
 */
export const OUTBOX_BACKOFF_BASE_MS_V1 = 1_000;
export const OUTBOX_BACKOFF_CAP_MS_V1 = 5 * 60 * 1_000;

export function drainBackoffMsV1(attemptsBefore: number): number {
  if (attemptsBefore <= 0) return OUTBOX_BACKOFF_BASE_MS_V1;
  const scaled = OUTBOX_BACKOFF_BASE_MS_V1 * 2 ** attemptsBefore;
  return Math.min(scaled, OUTBOX_BACKOFF_CAP_MS_V1);
}

/**
 * Whether a failed row is eligible to be claimed again at `now`.
 *
 * A row that has never been attempted is always eligible; the backoff only
 * applies once something has actually gone wrong.
 */
export function isDrainEligibleV1(input: {
  status: OutboxRowStatusV1;
  attempts: number;
  lastAttemptedAt: Date | null;
  now: Date;
}): boolean {
  if (input.status === 'DONE' || input.status === 'POISON') return false;
  if (input.status === 'PROCESSING') return false;
  if (input.attempts === 0 || input.lastAttemptedAt == null) return true;
  return input.now.getTime() - input.lastAttemptedAt.getTime() >= drainBackoffMsV1(input.attempts);
}

/* ------------------------------------------------------------------ */
/* L2. Run status after a drain                                        */
/* ------------------------------------------------------------------ */

export const PROMOTION_RUN_SIDE_EFFECT_STATUS_V1_VALUES = [
  'SIDE_EFFECTS_PENDING',
  'COMPLETED',
  'COMMITTED_WITH_SIDE_EFFECT_FAILURE',
] as const;
export type PromotionRunSideEffectStatusV1 =
  (typeof PROMOTION_RUN_SIDE_EFFECT_STATUS_V1_VALUES)[number];

/**
 * Where a run lands once its outbox has been worked.
 *
 * Order is the policy. A single poison row outranks any amount of success: a
 * run whose changes were only partly published must not read as `COMPLETED`,
 * because `COMPLETED` is what an operator checks before believing the alerts
 * went out. Rows still pending or retrying leave the run where it is — the
 * drain is not finished, and calling it finished would be a lie that a later
 * drain then has to un-tell.
 */
export function nextRunStatusAfterDrainV1(counts: {
  pending: number;
  processing: number;
  failed: number;
  poison: number;
}): PromotionRunSideEffectStatusV1 {
  if (counts.poison > 0) return 'COMMITTED_WITH_SIDE_EFFECT_FAILURE';
  if (counts.pending > 0 || counts.processing > 0 || counts.failed > 0) {
    return 'SIDE_EFFECTS_PENDING';
  }
  return 'COMPLETED';
}

/* ------------------------------------------------------------------ */
/* L3. Ports                                                           */
/* ------------------------------------------------------------------ */

/** One outbox row, as the drainer needs to see it. */
export interface OutboxRowV1 {
  id: string;
  dedupeKey: string;
  activationId: string;
  oldSnapshotId: string | null;
  newSnapshotId: string;
  canonicalEntity: string;
  canonicalNaturalKey: string;
  family: string;
  fiscalYear: number | null;
  fundingField: string | null;
  stage: string | null;
  oldOriginalValue: string | null;
  oldValueMillions: string | null;
  newOriginalValue: string | null;
  newValueMillions: string | null;
  changeClassification: string;
  suppressAlert: boolean;
  isCorrection: boolean;
  isRollback: boolean;
  attempts: number;
}

export interface OutboxDrainRepositoryV1 {
  /**
   * Whether the drain is paused for this domain/environment. Checked before a
   * batch is claimed, so a rollback in progress stops new work immediately.
   */
  isDrainPaused(domain: string, environment: string): Promise<boolean>;

  /**
   * Claim up to `limit` eligible rows with `FOR UPDATE SKIP LOCKED`, marking
   * them `PROCESSING`. Concurrent drainers therefore partition the backlog
   * rather than contending for it, and a drainer that dies mid-batch leaves
   * rows recoverable rather than locked forever.
   */
  claimBatch(input: {
    domain: string;
    environment: string;
    limit: number;
    now: Date;
  }): Promise<OutboxRowV1[]>;

  markDone(rowId: string, processedAt: Date): Promise<void>;
  markFailed(input: { rowId: string; error: string; attemptedAt: Date }): Promise<void>;
  markPoison(input: { rowId: string; error: string; attemptedAt: Date }): Promise<void>;

  /** Row counts by status for every run touched by this drain. */
  countsForActivation(activationId: string): Promise<{
    pending: number;
    processing: number;
    failed: number;
    poison: number;
  }>;
  setRunSideEffectStatus(input: {
    activationId: string;
    status: PromotionRunSideEffectStatusV1;
  }): Promise<void>;
}

/**
 * The downstream a row is published to — deltas, watches, caches, alerts.
 *
 * Deliberately one call. The drainer's job is delivery and bookkeeping; what
 * "publish" means belongs to the handler, and keeping it behind one method is
 * what lets the delta engine and the alert fan-out evolve without touching
 * retry semantics.
 */
export interface OutboxHandlerV1 {
  publish(row: OutboxRowV1): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* L4. The drain                                                       */
/* ------------------------------------------------------------------ */

export interface DrainResultV1 {
  claimed: number;
  done: number;
  retried: number;
  poisoned: number;
  paused: boolean;
  runStatuses: { activationId: string; status: PromotionRunSideEffectStatusV1 }[];
}

/**
 * Work one batch.
 *
 * One batch, not a loop: the caller decides cadence, which keeps this function
 * testable and lets a Fargate task, a test, and an operator command share it
 * without one of them inheriting somebody else's idea of how long to run.
 *
 * A handler failure is caught per row. One poisonous row must not abort the
 * batch around it — that would let a single bad row block every good one behind
 * it, which is the failure mode the poison status exists to prevent.
 */
export async function drainPromotionOutboxBatchV1(
  input: {
    domain: string;
    environment: string;
    now: Date;
    batchSize?: number;
    maxAttempts?: number;
  },
  repository: OutboxDrainRepositoryV1,
  handler: OutboxHandlerV1,
): Promise<DrainResultV1> {
  const empty: DrainResultV1 = {
    claimed: 0,
    done: 0,
    retried: 0,
    poisoned: 0,
    paused: false,
    runStatuses: [],
  };

  // Checked before claiming, not after. A rollback that pauses the drain must
  // not race a batch into flight behind it.
  if (await repository.isDrainPaused(input.domain, input.environment)) {
    return { ...empty, paused: true };
  }

  const rows = await repository.claimBatch({
    domain: input.domain,
    environment: input.environment,
    limit: input.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE_V1,
    now: input.now,
  });
  if (rows.length === 0) return empty;

  let done = 0;
  let retried = 0;
  let poisoned = 0;
  const activationIds = new Set<string>();

  for (const row of rows) {
    activationIds.add(row.activationId);
    try {
      await handler.publish(row);
      await repository.markDone(row.id, input.now);
      done += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const disposition = drainFailureDispositionV1(row.attempts, input.maxAttempts);
      if (disposition === 'poison') {
        await repository.markPoison({ rowId: row.id, error: detail, attemptedAt: input.now });
        poisoned += 1;
      } else {
        await repository.markFailed({ rowId: row.id, error: detail, attemptedAt: input.now });
        retried += 1;
      }
    }
  }

  // Advance every run this batch touched. A run only reaches COMPLETED when its
  // whole outbox is DONE, so a batch that emptied one activation's backlog does
  // not mark a different activation complete on its behalf.
  const runStatuses: DrainResultV1['runStatuses'] = [];
  for (const activationId of [...activationIds].sort()) {
    const counts = await repository.countsForActivation(activationId);
    const status = nextRunStatusAfterDrainV1(counts);
    await repository.setRunSideEffectStatus({ activationId, status });
    runStatuses.push({ activationId, status });
  }

  return { claimed: rows.length, done, retried, poisoned, paused: false, runStatuses };
}
