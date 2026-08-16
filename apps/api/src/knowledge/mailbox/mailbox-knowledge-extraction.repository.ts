import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { KnowledgeJsonObject } from '../knowledge.types.js';
import type {
  MailboxKnowledgeExtractionJobRecord,
  MailboxKnowledgeExtractionJobStatus,
} from './mailbox-knowledge-extraction.types.js';

interface MailboxKnowledgeExtractionJobRow {
  id: string;
  tenant_id: string;
  mailbox_job_id: string;
  mail_message_id: string;
  event_id: string;
  source_revision: string;
  content_hash: string;
  sensitivity: string;
  access_scope: unknown;
  status: string;
  attempt_count: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  last_error: string | null;
  result: unknown;
  assertion_count: number;
  held_count: number;
  created_at: Date;
  updated_at: Date;
}

/** Durable, tenant-bound operational state for Phase 6 mailbox extraction. */
@Injectable()
export class MailboxKnowledgeExtractionRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cross-tenant claiming is an intentional system operation, identical to the
   * Phase 4 worker. Every claimed row carries tenant_id and all later reads and
   * transitions re-enter a tenant transaction with an explicit tenant predicate.
   */
  async claimBatch(
    workerId: string,
    limit: number,
  ): Promise<MailboxKnowledgeExtractionJobRecord[]> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.prisma.withSystem(
      (tx) =>
        tx.$queryRaw<MailboxKnowledgeExtractionJobRow[]>`
        WITH stale_terminal AS (
          UPDATE knowledge_mailbox_extraction_jobs
          SET
            status = 'dead_letter',
            locked_at = NULL,
            locked_by = NULL,
            last_error = 'MaxAttemptsExceeded',
            updated_at = CURRENT_TIMESTAMP
          WHERE status = 'processing'
            AND attempt_count >= 100
            AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          RETURNING id
        ),
        candidates AS (
          SELECT id
          FROM knowledge_mailbox_extraction_jobs
          WHERE (
            (status IN ('pending', 'failed') AND available_at <= CURRENT_TIMESTAMP)
            OR
            (
              status = 'processing'
              AND attempt_count < 100
              AND locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
            )
          )
          -- Fresh due work has priority over stale recovery so one repeatedly
          -- crashed job cannot starve the live pending queue. Reclaimed rows
          -- get a fresh available_at below and are eligible on a later drain.
          ORDER BY
            CASE WHEN status IN ('pending', 'failed') THEN 0 ELSE 1 END,
            available_at ASC,
            created_at ASC,
            id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT ${boundedLimit}
        )
        UPDATE knowledge_mailbox_extraction_jobs AS jobs
        SET
          status = 'processing',
          attempt_count = jobs.attempt_count + 1,
          available_at = CASE
            WHEN jobs.status = 'processing' THEN CURRENT_TIMESTAMP
            ELSE jobs.available_at
          END,
          locked_at = CURRENT_TIMESTAMP,
          locked_by = ${workerId},
          last_error = NULL,
          updated_at = CURRENT_TIMESTAMP
        FROM candidates
        WHERE jobs.id = candidates.id
        RETURNING
          jobs.id,
          jobs.tenant_id,
          jobs.mailbox_job_id,
          jobs.mail_message_id,
          jobs.event_id,
          jobs.source_revision,
          jobs.content_hash,
          jobs.sensitivity,
          jobs.access_scope,
          jobs.status,
          jobs.attempt_count,
          jobs.available_at,
          jobs.locked_at,
          jobs.locked_by,
          jobs.last_error,
          jobs.result,
          jobs.assertion_count,
          jobs.held_count,
          jobs.created_at,
          jobs.updated_at
      `,
    );
    return rows.map(mapJob);
  }

  /**
   * Persist the validated model candidate set before any assertion writes. This
   * makes retries deterministic: a crash after a partial write reuses the exact
   * extraction output instead of asking a nondeterministic model for a new set.
   * `fail()` deliberately preserves this checkpoint; terminal success/skip then
   * replaces it with the final resolution manifest.
   */
  async checkpointExtraction(
    job: MailboxKnowledgeExtractionJobRecord,
    checkpoint: KnowledgeJsonObject,
  ): Promise<boolean> {
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_mailbox_extraction_jobs
        SET
          result = CAST(${JSON.stringify(checkpoint)} AS jsonb),
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      if (updated !== 1) return false;
      return true;
    });
  }

  /**
   * Hold the extraction row lock across one candidate's resolver/assertion
   * critical section. A stale worker cannot be reclaimed while this callback
   * is writing; a worker that was already fenced returns null and must stop.
   */
  async withClaimLease<T>(
    job: MailboxKnowledgeExtractionJobRecord,
    callback: () => Promise<T>,
  ): Promise<T | null> {
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const claimed = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM knowledge_mailbox_extraction_jobs
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
        FOR UPDATE
      `;
      if (claimed.length !== 1) return null;

      const value = await callback();
      const refreshed = await tx.$executeRaw`
        UPDATE knowledge_mailbox_extraction_jobs
        SET locked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      if (refreshed !== 1) return null;
      return value;
    });
  }

  async complete(
    job: MailboxKnowledgeExtractionJobRecord,
    result: KnowledgeJsonObject,
    assertionCount: number,
    heldCount: number,
  ): Promise<boolean> {
    return this.updateTerminal(job, 'succeeded', {
      result,
      assertionCount,
      heldCount,
      error: null,
    });
  }

  async skip(
    job: MailboxKnowledgeExtractionJobRecord,
    reason: string,
    result: KnowledgeJsonObject | null = null,
  ): Promise<boolean> {
    return this.updateTerminal(job, 'skipped', {
      result,
      assertionCount: 0,
      heldCount: 0,
      error: reason,
    });
  }

  async fail(
    job: MailboxKnowledgeExtractionJobRecord,
    error: unknown,
    maxAttempts: number,
  ): Promise<boolean> {
    const terminal = job.attemptCount >= maxAttempts;
    const delaySeconds = Math.min(
      15 * 60,
      Math.max(30, 30 * 2 ** Math.max(0, job.attemptCount - 1)),
    );
    const message = redactError(error);
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_mailbox_extraction_jobs
        SET
          status = ${terminal ? 'dead_letter' : 'failed'},
          available_at = CURRENT_TIMESTAMP + (${delaySeconds} * INTERVAL '1 second'),
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${message},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      if (updated !== 1) return false;
      return true;
    });
  }

  private async updateTerminal(
    job: MailboxKnowledgeExtractionJobRecord,
    status: Extract<MailboxKnowledgeExtractionJobStatus, 'succeeded' | 'skipped'>,
    input: {
      result: KnowledgeJsonObject | null;
      assertionCount: number;
      heldCount: number;
      error: string | null;
    },
  ): Promise<boolean> {
    return this.prisma.withTenant(job.tenantId, async (tx) => {
      const updated = await tx.$executeRaw`
        UPDATE knowledge_mailbox_extraction_jobs
        SET
          status = ${status},
          result = CAST(${input.result ? JSON.stringify(input.result) : null} AS jsonb),
          assertion_count = ${Math.max(0, Math.floor(input.assertionCount))},
          held_count = ${Math.max(0, Math.floor(input.heldCount))},
          locked_at = NULL,
          locked_by = NULL,
          last_error = ${input.error},
          updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ${job.tenantId}::uuid
          AND id = ${job.id}::uuid
          AND status = 'processing'
          AND locked_by = ${job.lockedBy}
          AND attempt_count = ${job.attemptCount}
      `;
      if (updated !== 1) return false;
      return true;
    });
  }
}

function mapJob(row: MailboxKnowledgeExtractionJobRow): MailboxKnowledgeExtractionJobRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    mailboxJobId: row.mailbox_job_id,
    mailMessageId: row.mail_message_id,
    eventId: row.event_id,
    sourceRevision: row.source_revision,
    contentHash: row.content_hash,
    sensitivity: row.sensitivity,
    accessScope: isJsonObject(row.access_scope) ? row.access_scope : {},
    status: row.status as MailboxKnowledgeExtractionJobStatus,
    attemptCount: Number(row.attempt_count),
    availableAt: row.available_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastError: row.last_error,
    result: isJsonObject(row.result) ? row.result : null,
    assertionCount: Number(row.assertion_count),
    heldCount: Number(row.held_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isJsonObject(value: unknown): value is KnowledgeJsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function redactError(error: unknown): string {
  // Provider responses and validation errors may echo private mailbox text.
  // Persist only a stable error class in operational state; the durable result
  // manifest and KnowledgeEvidence remain the only reviewable evidence paths.
  return error instanceof Error ? error.name : 'UnknownError';
}
