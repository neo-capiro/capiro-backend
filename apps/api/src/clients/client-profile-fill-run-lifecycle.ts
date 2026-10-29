import { queueFailedFillTask } from './client-profile-fill-retry.js';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import type { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { buildFillRunSummary, requeueFillReviewChecks } from './client-profile-fill-retry.js';
import { seedCompletionTasks } from './client-profile-fill-completion-plan-store.js';
import { TERMINAL_TASK_STATUSES } from './client-profile-fill-completion-runtime.shared.js';

export interface RunLifecyclePorts {
  assertClient(ctx: TenantContext, clientId: string): Promise<void>;
  hasCompletionTasks(tenantId: string, runId: string): Promise<boolean>;
  getRun(
    ctx: TenantContext,
    clientId: string,
    runId: string,
  ): ReturnType<ClientProfileFillCompletionService['getRun']>;
  requestTaskSweep(): void;
}

/** Installs, cancels, retries and finalizes the same two durable task ledgers. */
export class ClientProfileFillRunLifecycle {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workflow: ClientProfileFillWorkflowService,
    private readonly ports: RunLifecyclePorts,
  ) {}

  async ensureCompletionTasks(ctx: TenantContext, clientId: string, runId: string): Promise<void> {
    await this.prisma.withTenant(ctx.tenantId, tx =>
      seedCompletionTasks(tx, ctx.tenantId, clientId, runId),
    );
  }

  async cancelRun(ctx: TenantContext, clientId: string, runId: string) {
    await this.ports.assertClient(ctx, clientId);
    const hasAdvanced = await this.ports.hasCompletionTasks(ctx.tenantId, runId);
    if (!hasAdvanced) return this.workflow.cancelRun(ctx, clientId, runId);

    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Use the same run-before-task lock order as retry and finalization.
      await tx.$queryRawUnsafe(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid FOR UPDATE`,
        runId,
        ctx.tenantId,
        clientId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_extension_task
            SET status = 'cancelled', completed_at = now(), worker_id = NULL,
                heartbeat_at = NULL, updated_at = now()
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status IN ('queued', 'running')`,
        runId,
        ctx.tenantId,
        clientId,
      );
      await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_task
            SET status = 'cancelled', completed_at = now(), worker_id = NULL,
                heartbeat_at = NULL, updated_at = now()
          WHERE run_id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status IN ('queued', 'running')`,
        runId,
        ctx.tenantId,
        clientId,
      );
      const changed = await tx.$executeRawUnsafe(
        `UPDATE client_profile_fill_run
            SET status = 'cancelled', stage = 'cancelled', cancelled_at = now(),
                completed_at = now(), error = NULL, last_progress_at = now(), updated_at = now()
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status <> 'cancelled'`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (Number(changed) !== 1) throw new BadRequestException('This run cannot be cancelled');
    });
    return this.ports.getRun(ctx, clientId, runId);
  }

  async retryTask(ctx: TenantContext, clientId: string, runId: string, taskId: string) {
    await this.ports.assertClient(ctx, clientId);
    const changed = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM client_profile_fill_run
          WHERE id = $1::uuid AND tenant_id = $2::uuid AND client_id = $3::uuid
            AND status <> 'cancelled' FOR UPDATE`,
        runId,
        ctx.tenantId,
        clientId,
      );
      if (!runs.length) throw new BadRequestException('This run cannot be retried');
      const count = await queueFailedFillTask(tx, 'extension', ctx.tenantId, clientId, runId, taskId);
      if (Number(count) === 1) {
        await requeueFillReviewChecks(tx, runId, ctx.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = 'running', stage = 'research', completed_at = NULL,
                  error = NULL, last_progress_at = now(), updated_at = now()
            WHERE id = $1::uuid AND tenant_id = $2::uuid`,
          runId,
          ctx.tenantId,
        );
      }
      return Number(count);
    });
    if (changed !== 1) await this.workflow.retryTask(ctx, clientId, runId, taskId);
    this.ports.requestTaskSweep();
    return this.ports.getRun(ctx, clientId, runId);
  }

  async finalizeRuns(): Promise<void> {
    const runs = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ runId: string; tenantId: string }>>(
        `SELECT r.id AS "runId", r.tenant_id AS "tenantId"
           FROM client_profile_fill_run r
          WHERE r.status <> 'cancelled'
            AND EXISTS (SELECT 1 FROM client_profile_fill_extension_task extension
                         WHERE extension.run_id = r.id AND extension.tenant_id = r.tenant_id
                           AND (r.completed_at IS NULL OR extension.updated_at > r.completed_at))
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_extension_task pending
               WHERE pending.run_id = r.id AND pending.tenant_id = r.tenant_id
                 AND pending.status IN ('queued', 'running')
            )
            AND NOT EXISTS (
              SELECT 1 FROM client_profile_fill_task pending
               WHERE pending.run_id = r.id AND pending.tenant_id = r.tenant_id
                 AND pending.status IN ('queued', 'running')
            )
          ORDER BY r.updated_at ASC
          LIMIT 20`,
      ),
    );
    for (const run of runs) {
      await this.prisma.withSystem(async (tx) => {
        // Serialize with retry, then re-read BOTH task groups under the lock.
        const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM client_profile_fill_run WHERE id = $1::uuid
            AND tenant_id = $2::uuid AND status <> 'cancelled' FOR UPDATE`,
          run.runId,
          run.tenantId,
        );
        if (!locked.length) return;
        const statuses = await tx.$queryRawUnsafe<Array<{ status: string }>>(
          `SELECT status FROM client_profile_fill_task
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid
           UNION ALL
           SELECT status FROM client_profile_fill_extension_task
            WHERE run_id = $1::uuid AND tenant_id = $2::uuid`,
          run.runId,
          run.tenantId,
        );
        if (statuses.some((row) => !TERMINAL_TASK_STATUSES.has(row.status))) return;
        const failed = statuses.filter((row) => row.status === 'failed').length;
        const completed = statuses.filter(
          (row) => row.status === 'completed' || row.status === 'skipped',
        ).length;
        const status = failed > 0 ? (completed > 0 ? 'partial' : 'failed') : 'completed';
        const summary = await buildFillRunSummary(tx, run.runId, run.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run
              SET status = $3,
                  stage = CASE WHEN $3 = 'failed' THEN 'failed' ELSE 'review_ready' END,
                  summary_jsonb = $4::jsonb,
                  completed_at = now(),
                  last_progress_at = now(), updated_at = now(),
                  error = CASE WHEN $3 = 'failed' THEN 'All Fill with Meri tasks failed' ELSE NULL END
            WHERE id = $1::uuid AND tenant_id = $2::uuid AND status <> 'cancelled'`,
          run.runId,
          run.tenantId,
          status,
          JSON.stringify(summary),
        );
      });
    }
  }
}
