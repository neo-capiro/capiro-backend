/** Two-phase leased drain for ingestion and durable readiness catch-up. */
import type { AuthorityTrack, SourceFamily } from '@capiro/defense-domain';
import type { ObservationIngestionBridgeResult } from './observation-ingestion-bridge.service.js';
import type { ReadinessFamilyGroupV1 } from './promotion/readiness/cycle-family-readiness-v1.js';
import {
  OUTBOX_DEFAULT_BATCH_SIZE_V1,
  OUTBOX_MAX_ATTEMPTS_V1,
  drainFailureDispositionV1,
} from './promotion/promotion-outbox-drain-v1.js';
import type {
  IngestionOutboxDrainRepositoryV1,
  IngestionOutboxRowV1,
} from './ingestion-outbox-drain-repository-prisma-v1.js';
import {
  ingestionOutboxDispositionForBridgeResultV1,
  readinessScopeForSucceededObservationV1,
  SUPPORTED_DRAIN_FAMILY_GROUPS_V1,
} from './ingestion-outbox-drain-v1.js';

export interface IngestionDrainResultV1 {
  claimed: number;
  succeeded: number;
  governedReview: number;
  governedReject: number;
  retried: number;
  poisoned: number;
  leaseLost: number;
  readinessInvoked: number;
  readinessSucceeded: number;
  readinessRetried: number;
  readiness_deferred_committee: number;
  readinessSkippedNoScope: number;
  readinessFailures: { observationId: string; detail: string }[];
}
export interface IngestionOutboxDrainWorkerPortsV1 {
  repository: IngestionOutboxDrainRepositoryV1;
  bridge: { bridge(observationId: string): Promise<ObservationIngestionBridgeResult> };
  invokeReadiness(scope: {
    fiscalYear: number;
    authorityTrack: AuthorityTrack;
    familyGroup: ReadinessFamilyGroupV1;
  }): Promise<{
    outcome: string;
    planId?: string | null;
    planHash?: string | null;
    [key: string]: unknown;
  }>;
  loadObservationScope(
    observationId: string,
  ): Promise<{
    classifiedSourceFamily: SourceFamily;
    authorityTrack: AuthorityTrack;
    fiscalYear: number;
  } | null>;
}

export function emptyIngestionDrainResultV1(claimed = 0): IngestionDrainResultV1 {
  return emptyResult(claimed);
}

function emptyResult(claimed: number): IngestionDrainResultV1 {
  return {
    claimed,
    succeeded: 0,
    governedReview: 0,
    governedReject: 0,
    retried: 0,
    poisoned: 0,
    leaseLost: 0,
    readinessInvoked: 0,
    readinessSucceeded: 0,
    readinessRetried: 0,
    readiness_deferred_committee: 0,
    readinessSkippedNoScope: 0,
    readinessFailures: [],
  };
}

async function invokeAndPersistReadiness(
  row: IngestionOutboxRowV1,
  input: { leaseOwner: string; now: Date },
  ports: IngestionOutboxDrainWorkerPortsV1,
  result: IngestionDrainResultV1,
): Promise<void> {
  try {
    const observation = await ports.loadObservationScope(row.observationId);
    const scope = observation ? readinessScopeForSucceededObservationV1(observation) : null;
    if (!scope) {
      if (
        await ports.repository.markReadinessNotApplicable({
          rowId: row.id,
          leasedBy: input.leaseOwner,
        })
      )
        result.readinessSkippedNoScope++;
      else result.leaseLost++;
      return;
    }
    if (!(SUPPORTED_DRAIN_FAMILY_GROUPS_V1 as readonly string[]).includes(scope.familyGroup)) {
      if (
        await ports.repository.markReadinessDeferredCommittee({
          rowId: row.id,
          leasedBy: input.leaseOwner,
        })
      )
        result.readiness_deferred_committee++;
      else result.leaseLost++;
      return;
    }
    const outcome = await ports.invokeReadiness(scope);
    result.readinessInvoked++;
    const landed = await ports.repository.markReadinessSucceeded({
      rowId: row.id,
      leasedBy: input.leaseOwner,
      now: input.now,
      outcome: {
        readinessOutcome: outcome.outcome,
        planId: outcome.planId ?? null,
        planHash: outcome.planHash ?? null,
      },
    });
    if (landed) result.readinessSucceeded++;
    else result.leaseLost++;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const landed = await ports.repository.markReadinessRetryableFailure({
      rowId: row.id,
      leasedBy: input.leaseOwner,
      now: input.now,
      attemptsBefore: row.attempts,
      detail,
    });
    if (landed) {
      result.readinessRetried++;
      result.readinessFailures.push({ observationId: row.observationId, detail });
    } else result.leaseLost++;
  }
}

export async function drainIngestionOutboxBatchV1(
  input: { leaseOwner: string; now: Date; batchSize?: number; maxAttempts?: number },
  ports: IngestionOutboxDrainWorkerPortsV1,
): Promise<IngestionDrainResultV1> {
  const rows = await ports.repository.claimBatch({
    leaseOwner: input.leaseOwner,
    now: input.now,
    limit: input.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE_V1,
  });
  return processIngestionOutboxRowsV1(rows, input, ports);
}

/**
 * Governed single-row canary drain (PR #1318 Part G). Claims EXACTLY the
 * outbox row identified by `rowId` -- never a different row -- via
 * `repository.claimRowById`, then runs it through the identical
 * ingest-then-readiness pipeline `drainIngestionOutboxBatchV1` uses for a
 * batch of one. `claimed` is 0 or 1; there is no scenario where this
 * function processes more than the one named row. Use this for the first
 * production canary instead of `drainIngestionOutboxBatchV1({batchSize: 1})`,
 * which claims whichever eligible row sorts first by (created_at, id) --
 * not necessarily the row an operator inspected and chose.
 */
export async function drainIngestionOutboxRowV1(
  input: { leaseOwner: string; now: Date; rowId: string; maxAttempts?: number },
  ports: IngestionOutboxDrainWorkerPortsV1,
): Promise<IngestionDrainResultV1> {
  const claimed = await ports.repository.claimRowById({
    leaseOwner: input.leaseOwner,
    now: input.now,
    rowId: input.rowId,
  });
  return processIngestionOutboxRowsV1(claimed ? [claimed] : [], input, ports);
}

async function processIngestionOutboxRowsV1(
  rows: IngestionOutboxRowV1[],
  input: { leaseOwner: string; now: Date; maxAttempts?: number },
  ports: IngestionOutboxDrainWorkerPortsV1,
): Promise<IngestionDrainResultV1> {
  const result = emptyResult(rows.length);
  for (const row of rows) {
    try {
      const bridgeResult = await ports.bridge.bridge(row.observationId);
      const mapped = ingestionOutboxDispositionForBridgeResultV1(bridgeResult);
      if (mapped.disposition === 'succeeded') {
        if (!(await ports.repository.markSucceeded(row.id, input.leaseOwner, input.now))) {
          result.leaseLost++;
          continue;
        }
        result.succeeded++;
        if (
          !(await ports.repository.claimReadinessPendingRow({
            rowId: row.id,
            leaseOwner: input.leaseOwner,
            now: input.now,
          }))
        ) {
          result.leaseLost++;
          continue;
        }
        await invokeAndPersistReadiness({ ...row, attempts: 0 }, input, ports, result);
        continue;
      }
      const metadata = {
        governedDisposition: bridgeResult.status,
        verifierDecision: bridgeResult.verifierDecision,
        sourceDocumentId: bridgeResult.sourceDocumentId,
      };
      if (mapped.disposition === 'governed_review' || mapped.disposition === 'governed_reject') {
        const landed = await ports.repository.markGoverned({
          rowId: row.id,
          leasedBy: input.leaseOwner,
          disposition: mapped.disposition,
          detail: mapped.detail,
          metadata,
        });
        if (!landed) result.leaseLost++;
        else if (mapped.disposition === 'governed_review') result.governedReview++;
        else result.governedReject++;
      } else await recordFailure(row.id, row.attempts, mapped.detail);
    } catch (error) {
      await recordFailure(
        row.id,
        row.attempts,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return result;

  async function recordFailure(rowId: string, attemptsBefore: number, detail: string) {
    const poison =
      drainFailureDispositionV1(attemptsBefore, input.maxAttempts ?? OUTBOX_MAX_ATTEMPTS_V1) ===
      'poison';
    const landed = poison
      ? await ports.repository.markDeadLetterPoison({
          rowId,
          leasedBy: input.leaseOwner,
          detail,
          metadata: { governedDisposition: 'retries_exhausted' },
        })
      : await ports.repository.markRetryableFailure({
          rowId,
          leasedBy: input.leaseOwner,
          now: input.now,
          attemptsBefore,
          detail,
        });
    if (!landed) result.leaseLost++;
    else if (poison) result.poisoned++;
    else result.retried++;
  }
}

export async function drainReadinessPendingBatchV1(
  input: { leaseOwner: string; now: Date; batchSize?: number },
  ports: IngestionOutboxDrainWorkerPortsV1,
): Promise<IngestionDrainResultV1> {
  const rows = await ports.repository.claimReadinessPendingBatch({
    leaseOwner: input.leaseOwner,
    now: input.now,
    limit: input.batchSize ?? OUTBOX_DEFAULT_BATCH_SIZE_V1,
  });
  const result = emptyResult(rows.length);
  for (const row of rows) await invokeAndPersistReadiness(row, input, ports, result);
  return result;
}
