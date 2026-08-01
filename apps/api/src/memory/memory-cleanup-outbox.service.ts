import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryIngestService } from './memory-ingest.service.js';

/** Vocabulary of memory_cleanup_operation_check after 20260729011000:41-49. */
export const MEMORY_CLEANUP_OPERATIONS = [
  'index_memory_item',
  'revoke_projections',
  'supersede_projections',
  'expire_projections',
  'purge_projections',
] as const;
export type MemoryCleanupOperation = (typeof MEMORY_CLEANUP_OPERATIONS)[number];

/**
 * Operations this worker knows how to execute.
 *
 * `index_memory_item` joined this list in the gap-B2 work (closeout §4). It is
 * the one FORWARD operation here — every other entry deletes projections — so it
 * is the only one that needs a projector, which is injected rather than
 * reimplemented (see the constructor).
 */
export const DRAINABLE_CLEANUP_OPERATIONS = [
  'index_memory_item',
  'revoke_projections',
  'supersede_projections',
  'expire_projections',
  'purge_projections',
] as const;
export type DrainableCleanupOperation = (typeof DRAINABLE_CLEANUP_OPERATIONS)[number];

export const MAX_CLEANUP_ATTEMPTS = 8;

/**
 * Exponential backoff, capped at 6h, copied in SHAPE (not by import) from
 * IdentityOutboxService.backoffSeconds. apps/api/src/auth is guardrailed, so the
 * pattern is duplicated deliberately rather than refactored for reuse.
 */
export function cleanupBackoffSeconds(attempts: number): number {
  const n = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  return Math.min(6 * 60 * 60, 60 * Math.pow(2, Math.min(n, 10)));
}

export interface CleanupEnqueueInput {
  /**
   * Subject for DELETION jobs. Optional since
   * 20260811040000_memory_index_outbox_subject — an index job has no
   * memory_items row yet and names `clioMemoryId` instead.
   */
  memoryItemId?: string | null;
  /** The clio_memory row this item was projected from, when there is one. */
  clioMemoryId?: string | null;
  operation: DrainableCleanupOperation;
  /**
   * Stable per-effect key. The unique index is (tenant_id, idempotency_key)
   * (20260729010000:327), so re-running the same logical cleanup is a no-op
   * instead of a duplicate job.
   */
  idempotencyKey: string;
}

export interface CleanupDrainSummary {
  processed: number;
  succeeded: number;
  /** Jobs whose subject was already gone; completed rather than retried forever. */
  vanished: number;
  failed: number;
}

/**
 * Durable, idempotent cleanup of SECONDARY memory projections.
 *
 * Recall suppression is synchronous (the governed status flip inside the caller's
 * transaction); this outbox removes what that flip does not reach —
 * context_embeddings rows and the clio_memory KV source — so a failed or partial
 * cleanup is retried instead of silently leaving a revoked memory recallable
 * through the clio fast path.
 *
 * Drained OUT-OF-BAND by scripts/drain-memory-cleanup-outbox.ts (entrypoint verb),
 * NOT from an in-process scheduler: apps/api has no scheduler (@nestjs/schedule is
 * not a dependency, zero @Cron usages) and a multi-task service would have every
 * task racing the same rows. Same reasoning, and the same atomic conditional-UPDATE
 * claim, as scripts/drain-identity-outbox.ts.
 */
@Injectable()
export class MemoryCleanupOutboxService {
  private readonly logger = new Logger(MemoryCleanupOutboxService.name);

  /**
   * `ingest` supplies the ONE projector (`projectClioMemory`) so the forward
   * `index_memory_item` branch does not reimplement projection semantics —
   * closeout rule 11, one implementation per invariant. Optional so the many
   * existing unit tests that construct this service with a bare Prisma stub keep
   * working; an index job with no projector fails loudly rather than silently
   * completing, which would strand the memory unprojected.
   */
  constructor(
    private readonly prisma: PrismaService,
    // forwardRef breaks Store -> CleanupOutbox -> Ingest -> Store. Without it
    // Nest hangs resolving MemoryModule and the API container never binds :4000
    // (health fails; ECS SIGTERMs; exit 0 with only "Starting Capiro API").
    @Inject(forwardRef(() => MemoryIngestService))
    private readonly ingest?: MemoryIngestService,
  ) {}

  /** Run the injected projector, or fail the job if none was provided. */
  private async projectClioMemory(tenantId: string, clioMemoryId: string): Promise<void> {
    if (!this.ingest) {
      throw new Error('no projector wired: cannot execute index_memory_item');
    }
    await this.ingest.projectClioMemory(tenantId, clioMemoryId);
  }

  /**
   * Enqueue on the CALLER'S transaction, so the job is committed atomically with
   * the status flip that made the projection stale. A job enqueued in its own
   * transaction could survive a rolled-back revoke and delete a live projection.
   */
  async enqueue(
    tx: Prisma.TransactionClient,
    tenantId: string,
    input: CleanupEnqueueInput,
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO memory_cleanup_outbox (
        tenant_id, memory_item_id, clio_memory_id, operation, idempotency_key
      ) VALUES (
        ${tenantId}::uuid, ${input.memoryItemId ?? null}::uuid, ${input.clioMemoryId ?? null}::uuid,
        ${input.operation}, ${input.idempotencyKey.slice(0, 192)}
      )
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `;
  }

  /**
   * Mark a job completed because the caller ALREADY did the work on the fast
   * path, immediately after its commit. Used by indexing (`index_memory_item`,
   * the default) and by forget's revocation (`revoke_projections`).
   *
   * This is what keeps gap B2's fix from changing observable behaviour. The
   * producer enqueues the job inside its transaction (so the work is durably
   * owed before anything is attempted), then attempts the projection right away
   * exactly as the old fire-and-forget code did, then calls this. A reader sees
   * the same latency as before. The outbox row only ever survives to be drained
   * when that immediate attempt DIED — which is precisely the case that used to
   * be lost silently.
   *
   * Deliberately best-effort: if this bookkeeping write fails, the job stays
   * pending and the drain re-projects. `projectClioMemory` is an upsert keyed on
   * the derived slug, so a redundant re-projection is a no-op, not a duplicate.
   */
  async markIndexedOnFastPath(
    tenantId: string,
    clioMemoryId: string,
    operation: DrainableCleanupOperation = 'index_memory_item',
  ): Promise<void> {
    try {
      await this.prisma.withSystem(
        (tx) =>
          tx.$executeRaw`
          UPDATE memory_cleanup_outbox
          SET status = 'completed', completed_at = now(), last_error = NULL
          WHERE tenant_id = ${tenantId}::uuid
            AND clio_memory_id = ${clioMemoryId}::uuid
            AND operation = ${operation}
            AND status IN ('pending', 'failed')
        `,
      );
    } catch (err) {
      this.logger.warn(
        `fast-path index bookkeeping failed for clio_memory ${clioMemoryId}; ` +
          `the drain will re-project: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Drain due jobs. Idempotent and safe to run concurrently — each job is claimed
   * with an atomic conditional UPDATE, so a row is processed at most once per pass.
   */
  async drainPending(limit = 100): Promise<CleanupDrainSummary> {
    const due = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id
        FROM memory_cleanup_outbox
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= now()
          AND attempts < ${MAX_CLEANUP_ATTEMPTS}
        ORDER BY next_attempt_at ASC, created_at ASC
        LIMIT ${limit}
      `,
    );

    const summary: CleanupDrainSummary = {
      processed: 0,
      succeeded: 0,
      vanished: 0,
      failed: 0,
    };
    for (const row of due) {
      summary.processed += 1;
      try {
        const outcome = await this.processJob(row.id);
        if (outcome === 'completed') summary.succeeded += 1;
        else if (outcome === 'vanished') summary.vanished += 1;
        else if (outcome === 'failed') summary.failed += 1;
        // 'skipped' = another drain claimed it; neither success nor failure.
      } catch (err) {
        summary.failed += 1;
        this.logger.error(`memory-cleanup-outbox job ${row.id} threw: ${(err as Error).message}`);
      }
    }
    return summary;
  }

  /**
   * Claim one job and run it.
   *
   * The claim bumps `attempts` in the same conditional UPDATE that selects the
   * row, so two concurrent drains cannot both act on it and a job that crashes
   * mid-flight still burns an attempt (no infinite hot loop).
   */
  private async processJob(
    jobId: string,
  ): Promise<'completed' | 'vanished' | 'failed' | 'skipped'> {
    const claimed = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<
          Array<{
            id: string;
            tenant_id: string;
            memory_item_id: string;
            clio_memory_id: string | null;
            operation: string;
            attempts: number;
          }>
        >`
        UPDATE memory_cleanup_outbox
        SET status = 'running', attempts = attempts + 1
        WHERE id = ${jobId}::uuid
          AND status IN ('pending', 'failed')
        RETURNING id::text AS id,
                  tenant_id::text AS tenant_id,
                  memory_item_id::text AS memory_item_id,
                  clio_memory_id::text AS clio_memory_id,
                  operation,
                  attempts
      `,
    );
    const job = claimed[0];
    if (!job) return 'skipped'; // already completed, or claimed by a concurrent drain

    if (!(DRAINABLE_CLEANUP_OPERATIONS as readonly string[]).includes(job.operation)) {
      // Mirrors identity-outbox's `unknown job type` branch.
      await this.markFailed(jobId, `unsupported operation ${job.operation}`);
      return 'failed';
    }

    // FORWARD work: (re)project a committed clio_memory row into memory_items and
    // embed it. Reached only when the producer's immediate attempt died, since the
    // success path completes the row via markIndexedOnFastPath (closeout §4, B2).
    //
    // Runs OUTSIDE any database transaction on purpose: projectClioMemory calls
    // Bedrock to embed, and holding a Prisma connection across that network round
    // trip is the pool-starvation pattern that has already caused one production
    // incident. The claim above (status='running', attempts+1) is what makes this
    // safe to run un-transacted — a crash mid-projection burns an attempt and the
    // upsert is idempotent on retry.
    if (job.operation === 'index_memory_item') {
      if (!job.clio_memory_id) {
        await this.markFailed(jobId, 'index_memory_item job has no clio_memory_id');
        return 'failed';
      }
      try {
        await this.projectClioMemory(job.tenant_id, job.clio_memory_id);
        await this.markCompleted(jobId);
        this.logger.log(
          JSON.stringify({
            event: 'memory_cleanup_outbox.completed',
            job_id: jobId,
            tenant_id: job.tenant_id,
            operation: job.operation,
            // No key, value, title or body — bounded ids and status only.
            clio_memory_id: job.clio_memory_id,
            attempts: job.attempts,
          }),
        );
        return 'completed';
      } catch (err) {
        await this.markFailed(jobId, (err as Error).message);
        return 'failed';
      }
    }

    try {
      const result = await this.prisma.withSystem(async (tx) => {
        const exists = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id FROM memory_items
          WHERE id = ${job.memory_item_id}::uuid AND tenant_id = ${job.tenant_id}::uuid
          LIMIT 1
        `;
        // Subject already gone (e.g. MemoryPurgeService deleted the item during a
        // client offboarding — memory_cleanup_outbox.memory_item_id is NOT NULL
        // with NO foreign key, so nothing cascaded). There is nothing left to
        // clean, so complete instead of retrying to exhaustion forever.
        const vanished = exists.length === 0;
        const embeddings = await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE source_type = 'memory_item' AND source_id = ${job.memory_item_id}
        `;
        let clio = 0;
        if (job.clio_memory_id) {
          clio = await tx.$executeRaw`
            DELETE FROM clio_memory
            WHERE id = ${job.clio_memory_id}::uuid AND tenant_id = ${job.tenant_id}::uuid
          `;
        }
        return { vanished, embeddings, clio };
      });
      await this.markCompleted(jobId);
      this.logger.log(
        JSON.stringify({
          event: 'memory_cleanup_outbox.completed',
          job_id: jobId,
          tenant_id: job.tenant_id,
          operation: job.operation,
          subject_present: !result.vanished,
          embeddings_deleted: result.embeddings,
          clio_rows_deleted: result.clio,
        }),
      );
      return result.vanished ? 'vanished' : 'completed';
    } catch (err) {
      await this.markFailed(jobId, (err as Error).message);
      return 'failed';
    }
  }

  private async markCompleted(jobId: string): Promise<void> {
    await this.prisma.withSystem(
      (tx) =>
        tx.$executeRaw`
        UPDATE memory_cleanup_outbox
        SET status = 'completed', completed_at = now(), last_error = NULL
        WHERE id = ${jobId}::uuid
      `,
    );
  }

  /** Record the failure text and re-space the next attempt with real backoff. */
  private async markFailed(jobId: string, message: string): Promise<void> {
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<Array<{ attempts: number; tenant_id: string }>>`
        UPDATE memory_cleanup_outbox
        SET status = 'failed', last_error = ${message.slice(0, 1000)}
        WHERE id = ${jobId}::uuid
        RETURNING attempts, tenant_id::text AS tenant_id
      `,
    );
    const attempts = rows[0]?.attempts ?? 0;
    await this.prisma.withSystem(
      (tx) =>
        tx.$executeRaw`
        UPDATE memory_cleanup_outbox
        SET next_attempt_at = now() + (${cleanupBackoffSeconds(attempts)} || ' seconds')::interval
        WHERE id = ${jobId}::uuid AND status = 'failed'
      `,
    );
    this.logger.error(
      JSON.stringify({
        security_event: 'memory.cleanup_failed',
        job_id: jobId,
        tenant_id: rows[0]?.tenant_id ?? null,
        attempts,
        exhausted: attempts >= MAX_CLEANUP_ATTEMPTS,
        error: message.slice(0, 300),
        count: 1,
      }),
    );
  }
}
