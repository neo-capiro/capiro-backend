import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cleanupBackoffSeconds,
  DRAINABLE_CLEANUP_OPERATIONS,
  MAX_CLEANUP_ATTEMPTS,
  type DrainableCleanupOperation,
} from './memory-cleanup-outbox.service.js';
import { StrictMemoryProjectorService } from './strict-memory-projector.service.js';

const DEFAULT_LEASE_SECONDS = 5 * 60;
const MAX_BATCH_SIZE = 500;

interface ClaimedMemoryJob {
  id: string;
  tenant_id: string;
  memory_item_id: string | null;
  clio_memory_id: string | null;
  operation: string;
  attempts: number;
  lease_owner: string;
}

export interface MemoryProjectionDrainSummary {
  processed: number;
  succeeded: number;
  vanished: number;
  failed: number;
  deadLettered: number;
}

class MemoryWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'MemoryWorkerError';
  }
}

/**
 * Scheduled, failure-aware worker for durable memory projection obligations.
 *
 * Claims are batched under `FOR UPDATE SKIP LOCKED`, but all projection and
 * embedding network work runs AFTER the claim transaction commits. A container
 * crash leaves a bounded lease that another invocation can reclaim. Every terminal
 * update is conditioned on the opaque lease token, so an expired worker cannot
 * complete or fail a job that has already been reclaimed.
 */
@Injectable()
export class MemoryProjectionWorkerService {
  private readonly logger = new Logger(MemoryProjectionWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: StrictMemoryProjectorService,
  ) {}

  async drainPending(
    limit = 100,
    leaseSeconds = DEFAULT_LEASE_SECONDS,
  ): Promise<MemoryProjectionDrainSummary> {
    const boundedLimit = Math.min(MAX_BATCH_SIZE, Math.max(1, Math.floor(limit)));
    const boundedLease = Math.min(30 * 60, Math.max(30, Math.floor(leaseSeconds)));
    const leaseOwner = `memory-worker:${randomUUID()}`;

    const deadLettered = await this.deadLetterExhaustedLeases();
    const jobs = await this.claimBatch(boundedLimit, boundedLease, leaseOwner);
    const summary: MemoryProjectionDrainSummary = {
      processed: jobs.length,
      succeeded: 0,
      vanished: 0,
      failed: 0,
      deadLettered,
    };

    for (const job of jobs) {
      const outcome = await this.processJob(job);
      if (outcome === 'completed') summary.succeeded += 1;
      else if (outcome === 'vanished') summary.vanished += 1;
      else if (outcome === 'failed') summary.failed += 1;
      else if (outcome === 'dead_letter') summary.deadLettered += 1;
    }

    return summary;
  }

  private async deadLetterExhaustedLeases(): Promise<number> {
    return this.prisma.withSystem(
      (tx) =>
        tx.$executeRaw`
          UPDATE memory_cleanup_outbox
          SET status = 'dead_letter', dead_lettered_at = now(),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = COALESCE(last_error, 'lease_expired_after_attempt_ceiling')
          WHERE status = 'running'
            AND lease_expires_at <= now()
            AND attempts >= ${MAX_CLEANUP_ATTEMPTS}
        `,
    );
  }

  private async claimBatch(
    limit: number,
    leaseSeconds: number,
    leaseOwner: string,
  ): Promise<ClaimedMemoryJob[]> {
    const leaseInterval = `${leaseSeconds} seconds`;
    return this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<ClaimedMemoryJob[]>`
          WITH due AS (
            SELECT id
            FROM memory_cleanup_outbox
            WHERE attempts < ${MAX_CLEANUP_ATTEMPTS}
              AND (
                (status IN ('pending','failed') AND next_attempt_at <= now())
                OR (status = 'running' AND lease_expires_at <= now())
              )
            ORDER BY
              CASE WHEN status = 'running' THEN lease_expires_at ELSE next_attempt_at END ASC,
              created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE memory_cleanup_outbox AS job
          SET status = 'running', attempts = job.attempts + 1,
              lease_owner = ${leaseOwner},
              lease_expires_at = now() + ${leaseInterval}::interval,
              started_at = COALESCE(job.started_at, now()),
              last_error = NULL
          FROM due
          WHERE job.id = due.id
          RETURNING job.id::text AS id,
                    job.tenant_id::text AS tenant_id,
                    job.memory_item_id::text AS memory_item_id,
                    job.clio_memory_id::text AS clio_memory_id,
                    job.operation,
                    job.attempts,
                    job.lease_owner
        `,
    );
  }

  private async processJob(
    job: ClaimedMemoryJob,
  ): Promise<'completed' | 'vanished' | 'failed' | 'dead_letter'> {
    if (!(DRAINABLE_CLEANUP_OPERATIONS as readonly string[]).includes(job.operation)) {
      return this.failJob(job, new MemoryWorkerError('unsupported_operation'));
    }

    try {
      if (job.operation === 'index_memory_item') {
        if (!job.clio_memory_id) throw new MemoryWorkerError('missing_clio_memory_id');
        const projected = await this.projector.projectClioMemoryStrict(
          job.tenant_id,
          job.clio_memory_id,
        );
        if (projected === 'vanished') {
          await this.completeJob(job, true);
          return 'vanished';
        }
        await this.completeJob(job, false);
        return 'completed';
      }

      if (!job.memory_item_id) throw new MemoryWorkerError('missing_memory_item_id');
      const result = await this.prisma.withSystem(async (tx) => {
        const present = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM memory_items
          WHERE id = ${job.memory_item_id}::uuid
            AND tenant_id = ${job.tenant_id}::uuid
          LIMIT 1
        `;
        const embeddings = await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE source_type = 'memory_item' AND source_id = ${job.memory_item_id}
        `;
        let clio = 0;
        if (job.clio_memory_id) {
          clio = await tx.$executeRaw`
            DELETE FROM clio_memory
            WHERE id = ${job.clio_memory_id}::uuid
              AND tenant_id = ${job.tenant_id}::uuid
          `;
        }
        return { vanished: present.length === 0, embeddings, clio };
      });
      await this.completeJob(job, result.vanished);
      return result.vanished ? 'vanished' : 'completed';
    } catch (error) {
      return this.failJob(job, error);
    }
  }

  private async completeJob(job: ClaimedMemoryJob, vanished: boolean): Promise<void> {
    const changed = await this.prisma.withSystem(
      (tx) =>
        tx.$executeRaw`
          UPDATE memory_cleanup_outbox
          SET status = 'completed', completed_at = now(), last_error = NULL,
              lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ${job.id}::uuid
            AND status = 'running'
            AND lease_owner = ${job.lease_owner}
        `,
    );
    if (changed !== 1) throw new MemoryWorkerError('lease_lost_before_completion');
    this.logger.log(
      JSON.stringify({
        event: 'memory_cleanup_outbox.completed',
        job_id: job.id,
        tenant_id: job.tenant_id,
        operation: job.operation,
        attempts: job.attempts,
        subject_present: !vanished,
      }),
    );
  }

  private async failJob(
    job: ClaimedMemoryJob,
    error: unknown,
  ): Promise<'failed' | 'dead_letter'> {
    const errorCode = memoryWorkerErrorCode(error);
    const exhausted = job.attempts >= MAX_CLEANUP_ATTEMPTS;
    const nextInterval = `${cleanupBackoffSeconds(job.attempts)} seconds`;
    const rows = exhausted
      ? await this.prisma.withSystem(
          (tx) =>
            tx.$queryRaw<Array<{ status: string }>>`
              UPDATE memory_cleanup_outbox
              SET status = 'dead_letter', dead_lettered_at = now(),
                  last_error = ${errorCode},
                  lease_owner = NULL, lease_expires_at = NULL
              WHERE id = ${job.id}::uuid
                AND status = 'running'
                AND lease_owner = ${job.lease_owner}
              RETURNING status
            `,
        )
      : await this.prisma.withSystem(
          (tx) =>
            tx.$queryRaw<Array<{ status: string }>>`
              UPDATE memory_cleanup_outbox
              SET status = 'failed', last_error = ${errorCode},
                  next_attempt_at = now() + ${nextInterval}::interval,
                  lease_owner = NULL, lease_expires_at = NULL
              WHERE id = ${job.id}::uuid
                AND status = 'running'
                AND lease_owner = ${job.lease_owner}
              RETURNING status
            `,
        );

    if (!rows[0]) return 'failed';
    this.logger.error(
      JSON.stringify({
        security_event: 'memory.cleanup_failed',
        job_id: job.id,
        tenant_id: job.tenant_id,
        operation: job.operation,
        attempts: job.attempts,
        dead_lettered: exhausted,
        error_code: errorCode,
        count: 1,
      }),
    );
    return exhausted ? 'dead_letter' : 'failed';
  }
}

export function memoryWorkerErrorCode(error: unknown): string {
  if (error instanceof MemoryWorkerError) return error.code;
  if (error instanceof Error && /^[a-z0-9_.-]{1,80}$/i.test(error.message)) {
    return error.message.toLowerCase();
  }
  const name = error instanceof Error ? error.name : 'worker_error';
  const normalized = name.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').slice(0, 80);
  return normalized || 'worker_error';
}

export const MEMORY_WORKER_DEFAULT_LEASE_SECONDS = DEFAULT_LEASE_SECONDS;
export const MEMORY_WORKER_MAX_BATCH_SIZE = MAX_BATCH_SIZE;
export type MemoryProjectionOperation = DrainableCleanupOperation;
