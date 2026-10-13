import { randomUUID } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientProfileFillCompletionTaskType } from './client-profile-fill-completion-projection.js';
import {
  TaskDeferredError,
  type CompletionTaskRow,
  type CompletionTaskStatus,
} from './client-profile-fill-completion-runtime.shared.js';

const TASK_STALE_MS = 5 * 60_000;
const TASK_CLAIM_BATCH = 4;

export interface TaskLedgerPorts {
  safeError(error: unknown): string;
}

export interface RunActorRow {
  createdByUserId: string | null;
  status: string;
}

/** Canonical system-scoped extension-task claims, prerequisites and lease transitions. */
export class ClientProfileFillTaskLedger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workerId: string,
    private readonly ports: TaskLedgerPorts,
  ) {}

  async recoverStaleTasks(): Promise<void> {
    const cutoff = new Date(Date.now() - TASK_STALE_MS);
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = CASE WHEN attempt + 1 >= max_attempts THEN 'failed' ELSE 'queued' END,
                attempt = attempt + 1,
                completed_at = CASE WHEN attempt + 1 >= max_attempts THEN now() ELSE NULL END,
                next_attempt_at = CASE
                  WHEN attempt + 1 >= max_attempts THEN next_attempt_at
                  ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1)))
                END,
                error_code = 'stale_worker',
                error_message = 'Worker heartbeat expired; task recovered from durable state',
                worker_id = NULL, claimed_at = NULL, heartbeat_at = NULL, updated_at = now()
          WHERE status = 'running'
            AND COALESCE(heartbeat_at, claimed_at, updated_at) < $1`,
        cutoff,
      ),
    );
  }

  async claimTasks(): Promise<CompletionTaskRow[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<CompletionTaskRow[]>(
        `WITH candidates AS (
           SELECT t.id
             FROM client_profile_fill_extension_task t
             JOIN client_profile_fill_run r ON r.id = t.run_id
            WHERE t.status = 'queued'
              AND t.next_attempt_at <= now()
              AND r.status <> 'cancelled'
              AND NOT EXISTS (
                SELECT 1
                  FROM client_profile_fill_extension_task dependency
                 WHERE dependency.run_id = t.run_id
                   AND dependency.task_key = ANY(t.depends_on)
                   AND dependency.status IN ('queued', 'running')
              )
            ORDER BY t.created_at ASC, t.task_key ASC
            FOR UPDATE OF t SKIP LOCKED
            LIMIT $1
         )
         UPDATE client_profile_fill_extension_task t
            SET status = 'running', worker_id = $2, claimed_at = now(),
                heartbeat_at = now(), updated_at = now()
           FROM candidates c
          WHERE t.id = c.id
         RETURNING t.id,
                   t.run_id AS "runId",
                   t.tenant_id AS "tenantId",
                   t.client_id AS "clientId",
                   t.task_type AS "taskType",
                   t.task_key AS "taskKey",
                   t.status,
                   t.depends_on AS "dependsOn",
                   t.attempt,
                   t.max_attempts AS "maxAttempts",
                   t.input_jsonb AS input,
                   t.output_summary_jsonb AS "outputSummary",
                   t.error_code AS "errorCode",
                   t.error_message AS "errorMessage",
                   t.worker_id AS "workerId",
                   t.claimed_at AS "claimedAt",
                   t.heartbeat_at AS "heartbeatAt",
                   t.next_attempt_at AS "nextAttemptAt",
                   t.completed_at AS "completedAt",
                   t.created_at AS "createdAt",
                   t.updated_at AS "updatedAt"`,
        TASK_CLAIM_BATCH,
        // A fresh lease also fences callbacks after a deferred task is reclaimed.
        `${this.workerId}:${randomUUID()}`,
      ),
    );
  }

  async assertCoreDependencies(task: CompletionTaskRow): Promise<void> {
    const requirements: Partial<Record<ClientProfileFillCompletionTaskType, string[]>> = {
      federal_market: ['sam_gov'],
      facility_resolution: ['public_web', 'sam_gov', 'client_document'],
      advocacy_history: ['synced_email', 'lda', 'program_elements', 'bill_tracker'],
      lifecycle_outcomes: ['program_elements', 'bill_tracker'],
    };
    const required = requirements[task.taskType] ?? [];
    const waitForAll = task.taskType === 'reconciliation' || task.taskType === 'completion_audit';
    if (!required.length && !waitForAll) return;
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ pending: number }>>(
        `SELECT COUNT(*)::int AS pending
           FROM client_profile_fill_task
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid
            AND ($4::boolean OR task_type = ANY($3::text[]))
            AND status IN ('queued', 'running')`,
        task.runId,
        task.tenantId,
        required,
        waitForAll,
      ),
    );
    if (Number(rows[0]?.pending ?? 0) > 0) {
      throw new TaskDeferredError('Waiting for prerequisite Fill specialists');
    }
  }

  async finishTask(
    task: CompletionTaskRow,
    status: Extract<CompletionTaskStatus, 'completed' | 'skipped' | 'cancelled'>,
    summary: Record<string, unknown>,
  ) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = $4, output_summary_jsonb = $5::jsonb,
                completed_at = now(), heartbeat_at = NULL, worker_id = NULL,
                error_code = NULL, error_message = NULL, updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $6`,
        task.id,
        task.runId,
        task.tenantId,
        status,
        JSON.stringify(summary),
        task.workerId,
      ),
    );
  }

  async deferTask(task: CompletionTaskRow, reason: string) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = 'queued', next_attempt_at = now() + interval '2 seconds',
                claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                error_code = 'waiting_for_dependency', error_message = $4, updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $5`,
        task.id,
        task.runId,
        task.tenantId,
        reason,
        task.workerId,
      ),
    );
  }

  async failTask(task: CompletionTaskRow, error: unknown) {
    const nextAttempt = task.attempt + 1;
    const terminal = nextAttempt >= task.maxAttempts;
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = $4,
                attempt = attempt + 1,
                completed_at = CASE WHEN $4 = 'failed' THEN now() ELSE NULL END,
                next_attempt_at = CASE
                  WHEN $4 = 'failed' THEN next_attempt_at
                  ELSE now() + make_interval(secs => LEAST(120, 5 * (attempt + 1)))
                END,
                error_code = 'task_error', error_message = $5,
                claimed_at = NULL, heartbeat_at = NULL, worker_id = NULL,
                updated_at = now()
          WHERE id = $1::uuid AND run_id = $2::uuid AND tenant_id = $3::uuid
            AND status = 'running' AND worker_id = $6`,
        task.id,
        task.runId,
        task.tenantId,
        terminal ? 'failed' : 'queued',
        this.ports.safeError(error),
        task.workerId,
      ),
    );
  }

  async heartbeat(task: CompletionTaskRow) {
    await this.prisma.withSystem((tx) =>
      tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET heartbeat_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'running' AND worker_id = $2`,
        task.id,
        task.workerId,
      ),
    );
  }

  loadRunActor(task: CompletionTaskRow): Promise<RunActorRow[]> {
    return this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ createdByUserId: string | null; status: string }>>(
        `SELECT created_by_user_id AS "createdByUserId", status
           FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid`,
        task.runId,
        task.tenantId,
        task.clientId,
      ),
    );
  }
}
