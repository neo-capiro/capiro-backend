import { BadRequestException, ConflictException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { requireOwnerClient } from './client-ordered-owner.access.js';
import { reviewHash } from './client-profile-fill-review-snapshot.js';
import { queueFailedFillTask, requeueFillReviewChecks } from './client-profile-fill-retry.js';

export type ResearchRetryCommand = {
  requestId: string;
  expectedAttempt: number;
  expectedTaskType: string;
};
export type ResearchRetryResult = {
  requestId: string;
  runId: string;
  taskId: string;
  expectedAttempt: number;
  expectedTaskType: string;
  status: 'queued' | 'refused';
  reason: string | null;
};
const action = 'client_profile_fill.task_retry';

/** A retry's task transition and immutable receipt use the existing run/task/audit owners. */
export async function retryResearchTask(
  prisma: PrismaService,
  ctx: TenantContext,
  clientId: string,
  runId: string,
  taskId: string,
  command: ResearchRetryCommand,
) {
  if (
    !command ||
    !isUUID(command.requestId) ||
    !isUUID(runId) ||
    !isUUID(taskId) ||
    !Number.isSafeInteger(command.expectedAttempt) ||
    command.expectedAttempt < 0 ||
    !/^[a-z_]{1,80}$/.test(command.expectedTaskType)
  )
    throw new BadRequestException(
      'A unique retry request and the reviewed task attempt are required',
    );
  const requestId = command.requestId.toLowerCase();
  const digest = reviewHash({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    clientId,
    runId,
    taskId,
    expectedAttempt: command.expectedAttempt,
    expectedTaskType: command.expectedTaskType,
  });
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    await requireOwnerClient(tx, ctx, clientId);
    const receipt = await tx.auditLog.findFirst({
      where: { id: requestId, tenantId: ctx.tenantId },
    });
    if (receipt) {
      const saved = receipt.after as {
        schemaVersion?: number;
        digest?: string;
        result?: ResearchRetryResult;
      } | null;
      if (
        receipt.action !== action ||
        receipt.entityId !== clientId ||
        receipt.actorUserId !== ctx.userId ||
        saved?.schemaVersion !== 1 ||
        saved.digest !== digest ||
        !saved.result
      )
        throw new ConflictException('Retry request identity or inputs changed');
      return { ...saved.result, replayed: true };
    }
    const result: ResearchRetryResult = {
      requestId,
      runId,
      taskId,
      expectedAttempt: command.expectedAttempt,
      expectedTaskType: command.expectedTaskType,
      status: 'refused',
      reason: 'The run or task changed. Refresh its saved status before choosing another retry.',
    };
    const runs = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM client_profile_fill_run WHERE id=$1::uuid AND tenant_id=$2::uuid
        AND client_id=$3::uuid AND workflow_version>=2 AND status<>'cancelled' FOR UPDATE`,
      runId,
      ctx.tenantId,
      clientId,
    );
    if (runs.length) {
      let changed = await queueFailedFillTask(
        tx,
        'extension',
        ctx.tenantId,
        clientId,
        runId,
        taskId,
        command,
      );
      if (!changed)
        changed = await queueFailedFillTask(
          tx,
          'core',
          ctx.tenantId,
          clientId,
          runId,
          taskId,
          command,
        );
      if (changed === 1) {
        await requeueFillReviewChecks(tx, runId, ctx.tenantId);
        await tx.$executeRawUnsafe(
          `UPDATE client_profile_fill_run SET status='running', stage='research', completed_at=NULL,
            error=NULL, last_progress_at=now(), updated_at=now()
            WHERE id=$1::uuid AND tenant_id=$2::uuid AND client_id=$3::uuid`,
          runId,
          ctx.tenantId,
          clientId,
        );
        result.status = 'queued';
        result.reason = null;
      }
    }
    await tx.auditLog.create({
      data: {
        id: requestId,
        tenantId: ctx.tenantId,
        actorUserId: ctx.userId,
        actorRole: ctx.role,
        action,
        entityType: 'client_profile_fill_run',
        entityId: clientId,
        after: { schemaVersion: 1, digest, result } as Prisma.InputJsonValue,
      },
    });
    return { ...result, replayed: false };
  });
}
