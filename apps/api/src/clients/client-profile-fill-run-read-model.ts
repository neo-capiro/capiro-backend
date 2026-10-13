import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { asRecord, asString } from './client-profile-fill.helpers.js';
import { mergeFillProgress } from './client-profile-fill-completion-projection.js';
import {
  TERMINAL_TASK_STATUSES,
  type CompletionTaskRow,
} from './client-profile-fill-completion-runtime.shared.js';

interface RunReadModelPorts {
  loadCompletionTasks(
    tenantId: string,
    clientId: string,
    runId: string,
  ): Promise<CompletionTaskRow[]>;
}

/** Reads and projects the existing Core and extension ledgers into one run. */
export class ClientProfileFillRunReadModel {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: RunReadModelPorts,
  ) {}

  async hasCompletionTasks(tenantId: string, runId: string): Promise<boolean> {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ present: boolean }>>(
        `SELECT EXISTS(
           SELECT 1 FROM client_profile_fill_extension_task
            WHERE tenant_id = $1::uuid AND run_id = $2::uuid
         ) AS present`,
        tenantId,
        runId,
      ),
    );
    return rows[0]?.present === true;
  }

  async latestActiveCompletionRun(tenantId: string, clientId: string) {
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT DISTINCT t.run_id AS id
           FROM client_profile_fill_extension_task t
           JOIN client_profile_fill_run r ON r.id = t.run_id
          WHERE t.tenant_id = $1::uuid AND t.client_id = $2::uuid
            AND t.status IN ('queued', 'running')
            AND r.status <> 'cancelled'
          ORDER BY id DESC
          LIMIT 1`,
        tenantId,
        clientId,
      ),
    );
    return rows[0] ?? null;
  }

  async mergeRun(ctx: TenantContext, clientId: string, core: Record<string, unknown>) {
    const runId = asString(core.id);
    if (!runId) return core;
    const tasks = await this.ports.loadCompletionTasks(ctx.tenantId, clientId, runId);
    const coreTasks = Array.isArray(core.tasks)
      ? (core.tasks as Array<Record<string, unknown>>)
      : [];
    const allTasks = [...coreTasks, ...tasks];
    const progress = mergeFillProgress(allTasks);
    const pending =
      core.status !== 'cancelled' &&
      allTasks.some((task) => task.status === 'queued' || task.status === 'running');
    const allTerminal =
      allTasks.length > 0 &&
      allTasks.every((task) => TERMINAL_TASK_STATUSES.has(String(task.status)));
    const anyFailed = allTasks.some((task) => task.status === 'failed');
    const anyCompleted = allTasks.some(
      (task) => task.status === 'completed' || task.status === 'skipped',
    );
    const status =
      core.status === 'cancelled'
        ? 'cancelled'
        : pending
          ? 'running'
          : allTerminal
            ? anyFailed
              ? anyCompleted
                ? 'partial'
                : 'failed'
              : 'completed'
            : core.status;
    const stage = pending
      ? tasks.some(
          (task) =>
            task.status === 'running' &&
            (task.taskType === 'reconciliation' || task.taskType === 'completion_audit'),
        )
        ? 'reconciliation'
        : 'research'
      : status === 'failed'
        ? 'failed'
        : status === 'cancelled'
          ? 'cancelled'
          : 'review_ready';
    const sourceStates = { ...asRecord(core.sourceStates) };
    for (const task of tasks) {
      sourceStates[task.taskType] = {
        status: task.status,
        count: Number(asRecord(task.outputSummary).count ?? 0),
        error: task.errorMessage,
      };
    }
    return {
      ...core,
      status,
      stage,
      completedAt: pending ? null : core.completedAt,
      sourceStates,
      progress,
      tasks: allTasks,
    };
  }

  async loadCompletionTasks(tenantId: string, clientId: string, runId: string) {
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.$queryRawUnsafe<CompletionTaskRow[]>(
        `SELECT id,
                run_id AS "runId",
                tenant_id AS "tenantId",
                client_id AS "clientId",
                task_type AS "taskType",
                task_key AS "taskKey",
                status,
                depends_on AS "dependsOn",
                attempt,
                max_attempts AS "maxAttempts",
                input_jsonb AS input,
                output_summary_jsonb AS "outputSummary",
                error_code AS "errorCode",
                error_message AS "errorMessage",
                worker_id AS "workerId",
                claimed_at AS "claimedAt",
                heartbeat_at AS "heartbeatAt",
                next_attempt_at AS "nextAttemptAt",
                completed_at AS "completedAt",
                created_at AS "createdAt",
                updated_at AS "updatedAt"
           FROM client_profile_fill_extension_task
          WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND run_id = $3::uuid
          ORDER BY created_at ASC, task_key ASC`,
        tenantId,
        clientId,
        runId,
      ),
    );
  }
}
