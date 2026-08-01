import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  cleanupBackoffSeconds,
  DRAINABLE_CLEANUP_OPERATIONS,
  MAX_CLEANUP_ATTEMPTS,
  type DrainableCleanupOperation,
} from './memory-cleanup-outbox.service.js';
import {
  memoryWorkerErrorCode,
  MEMORY_WORKER_DEFAULT_LEASE_SECONDS,
  MEMORY_WORKER_MAX_BATCH_SIZE,
  type MemoryProjectionDrainSummary,
} from './memory-projection-worker.service.js';
import { exactProjectionIdempotencyKey } from './exact-memory-cleanup-outbox.service.js';
import { StrictMemoryProjectorService } from './strict-memory-projector.service.js';

interface ExactClaimedMemoryJob {
  id: string;
  tenant_id: string;
  memory_item_id: string | null;
  clio_memory_id: string | null;
  operation: string;
  idempotency_key: string;
  expected_source_version: Date | null;
  expected_content_hash: string | null;
  attempts: number;
  lease_owner: string;
}

export interface ExactMemoryProjectionDrainSummary extends MemoryProjectionDrainSummary {
  superseded: number;
}

class ExactMemoryWorkerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ExactMemoryWorkerError';
  }
}

/**
 * Phase 6 scheduled worker.
 *
 * Every index obligation is projected against the version/hash captured when the
 * source mutation committed. Terminal updates bind the exact job id and lease token.
 */
@Injectable()
export class ExactMemoryProjectionWorkerService {
  private readonly logger = new Logger(ExactMemoryProjectionWorkerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly projector: StrictMemoryProjectorService,
  ) {}

  async drainPending(
    limit = 100,
    leaseSeconds = MEMORY_WORKER_DEFAULT_LEASE_SECONDS,
  ): Promise<ExactMemoryProjectionDrainSummary> {
    const boundedLimit = Math.min(MEMORY_WORKER_MAX_BATCH_SIZE, Math.max(1, Math.floor(limit)));
    const boundedLease = Math.min(30 * 60, Math.max(30, Math.floor(leaseSeconds)));
    const leaseOwner = `memory-worker:${randomUUID()}`;

    const deadLettered = await this.deadLetterExhaustedLeases();
    const jobs = await this.claimBatch(boundedLimit, boundedLease, leaseOwner);
    const summary: ExactMemoryProjectionDrainSummary = {
      processed: jobs.length,
      succeeded: 0,
      vanished: 0,
      failed: 0,
      deadLettered,
      superseded: 0,
    };

    for (const job of jobs) {
      const outcome = await this.processJob(job);
      if (outcome === 'completed') summary.succeeded += 1;
      else if (outcome === 'vanished') summary.vanished += 1;
      else if (outcome === 'failed') summary.failed += 1;
      else if (outcome === 'dead_letter') summary.deadLettered += 1;
      else if (outcome === 'superseded') summary.superseded += 1;
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
  ): Promise<ExactClaimedMemoryJob[]> {
    const leaseInterval = `${leaseSeconds} seconds`;
    return this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<ExactClaimedMemoryJob[]>`
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
                    job.idempotency_key,
                    job.expected_source_version,
                    job.expected_content_hash,
                    job.attempts,
                    job.lease_owner
        `,
    );
  }

  private async processJob(
    job: ExactClaimedMemoryJob,
  ): Promise<'completed' | 'vanished' | 'superseded' | 'failed' | 'dead_letter'> {
    if (!(DRAINABLE_CLEANUP_OPERATIONS as readonly string[]).includes(job.operation)) {
      return this.failJob(job, new ExactMemoryWorkerError('unsupported_operation'));
    }

    try {
      if (job.operation === 'index_memory_item') {
        if (!job.clio_memory_id) {
          throw new ExactMemoryWorkerError('missing_clio_memory_id');
        }
        if (!job.expected_source_version || !job.expected_content_hash) {
          throw new ExactMemoryWorkerError('missing_projection_expectation');
        }

        const sourceVersion = job.expected_source_version.toISOString();
        const expectedKey = exactProjectionIdempotencyKey(
          job.clio_memory_id,
          sourceVersion,
          job.expected_content_hash,
        );
        if (job.idempotency_key !== expectedKey) {
          throw new ExactMemoryWorkerError('projection_idempotency_binding_mismatch');
        }

        const receipt = await this.projector.projectClioMemoryStrict(
          job.tenant_id,
          job.clio_memory_id,
          {
            sourceVersion,
            contentHash: job.expected_content_hash,
            memoryItemId: job.memory_item_id,
            idempotencyKey: job.idempotency_key,
          },
        );

        if (receipt.outcome === 'superseded') {
          await this.supersedeJob(job);
          return 'superseded';
        }
        if (receipt.outcome === 'vanished') {
          await this.completeJob(job, true);
          return 'vanished';
        }
        if (
          receipt.idempotencyKey !== job.idempotency_key ||
          receipt.sourceVersion !== sourceVersion ||
          receipt.contentHash !== job.expected_content_hash
        ) {
          throw new ExactMemoryWorkerError('projection_receipt_binding_mismatch');
        }

        await this.completeJob(job, false);
        return 'completed';
      }

      if (!job.memory_item_id) {
        throw new ExactMemoryWorkerError('missing_memory_item_id');
      }
      const result = await this.prisma.withSystem(async (tx) => {
        const present = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id::text AS id
          FROM memory_items
          WHERE id = ${job.memory_item_id}::uuid
            AND tenant_id = ${job.tenant_id}::uuid
          LIMIT 1
        `;
        await tx.$executeRaw`
          DELETE FROM context_embeddings
          WHERE source_type = 'memory_item' AND source_id = ${job.memory_item_id}
        `;
        if (job.clio_memory_id) {
          await tx.$executeRaw`
            DELETE FROM clio_memory
            WHERE id = ${job.clio_memory_id}::uuid
              AND tenant_id = ${job.tenant_id}::uuid
          `;
        }
        return { vanished: present.length === 0 };
      });
      await this.completeJob(job, result.vanished);
      return result.vanished ? 'vanished' : 'completed';
    } catch (error) {
      return this.failJob(job, error);
    }
  }

  private async completeJob(job: ExactClaimedMemoryJob, vanished: boolean): Promise<void> {
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
    if (changed !== 1) {
      throw new ExactMemoryWorkerError('lease_lost_before_completion');
    }
    this.logTerminal(job, vanished ? 'vanished' : 'completed');
  }

  private async supersedeJob(job: ExactClaimedMemoryJob): Promise<void> {
    const changed = await this.prisma.withSystem(
      (tx) =>
        tx.$executeRaw`
          UPDATE memory_cleanup_outbox
          SET status = 'superseded', superseded_at = now(),
              last_error = 'source_advanced',
              lease_owner = NULL, lease_expires_at = NULL
          WHERE id = ${job.id}::uuid
            AND status = 'running'
            AND lease_owner = ${job.lease_owner}
        `,
    );
    if (changed !== 1) {
      throw new ExactMemoryWorkerError('lease_lost_before_supersede');
    }
    this.logTerminal(job, 'superseded');
  }

  private async failJob(
    job: ExactClaimedMemoryJob,
    error: unknown,
  ): Promise<'failed' | 'dead_letter'> {
    const errorCode =
      error instanceof ExactMemoryWorkerError ? error.code : memoryWorkerErrorCode(error);
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

  private logTerminal(
    job: ExactClaimedMemoryJob,
    outcome: 'completed' | 'vanished' | 'superseded',
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'memory_cleanup_outbox.terminal',
        job_id: job.id,
        tenant_id: job.tenant_id,
        operation: job.operation,
        attempts: job.attempts,
        outcome,
      }),
    );
  }
}

export type ExactMemoryProjectionOperation = DrainableCleanupOperation;
