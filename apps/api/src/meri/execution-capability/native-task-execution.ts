import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { type TenantContext } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EngagementService } from '../../engagement/engagement.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { assertOwnedResearchPortfolioTask } from '../../engagement/research-portfolio-task-access.js';
import { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { UUID,
  type NativeApprovalProposal, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import { retainedReadObject } from '../retained-read-context.js';
import { receiveNativeDatabaseCommand, visibleClients } from './native-approved-database-execution.js';

type Task = Awaited<ReturnType<EngagementService['createTask']>>;
type Ports = { prisma: PrismaService; engagement: EngagementService; approvals: NativeApprovalService; tenant: TenantContextMiddleware };
type TaskResult = { id: string; title: string; status: string; dueDate: string | null; clientId: string | null } &
  ({ createdAt: string } | { updatedAt: string });
export type NativeTaskOutcome = {
  execution: { kind: 'native-task'; proposalId: string; commandSha256: string; idempotencyKey: string;
    binding: NativeRunBinding; completedAt: string; approvalDecisionSha256: string };
  result: TaskResult;
};
export type NativeTaskNotExecuted = {
  state: 'NOT_EXECUTED'; proposalId: string; commandSha256: string; idempotencyKey: string;
  binding: NativeRunBinding; reason: 'expired'; checkedAt: string;
};
const denied = () => new ForbiddenException('Native task authority refused');
const conflict = () => new ConflictException('Native task command differs from its retained decision or outcome');
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const statuses = ['todo', 'in_progress', 'done', 'blocked', 'canceled'];

function snapshot(task: Task, action: string): TaskResult {
  return { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate?.toISOString() ?? null,
    clientId: task.clientId, ...(action === 'task.create' ? { createdAt: task.createdAt.toISOString() } : { updatedAt: task.updatedAt.toISOString() }) };
}

/** Validate immutable historical result, not the task's mutable current title/status. */
function validateResult(raw: unknown, p: NativeApprovalProposal): TaskResult {
  const timeField = p.command.action === 'task.create' ? 'createdAt' : 'updatedAt';
  const r = retainedReadObject(raw, ['id', 'title', 'status', 'dueDate', 'clientId', timeField]);
  if (typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.title !== 'string' || !statuses.includes(String(r.status)) ||
      (r.clientId !== null && (typeof r.clientId !== 'string' || !UUID.test(r.clientId))) || !instant(r[timeField]) ||
      (r.dueDate !== null && (!instant(r.dueDate) || Date.parse(r.dueDate) % 86400000 !== 0))) throw conflict();
  const args = p.command.arguments;
  if (p.command.action === 'task.create') {
    if (r.status !== 'todo' || !['title', 'clientId', 'dueDate'].every(k => r[k] === args[k])) throw conflict();
  } else if (r.id !== args.taskId || !Object.entries(args.patch as Record<string, unknown>).every(([k, value]) => r[k] === value)) throw conflict();
  return r as TaskResult;
}

async function currentTask(tx: Prisma.TransactionClient, ctx: TenantContext, taskId: string, selectedClientId: string | null) {
  await tx.$queryRaw`SELECT id::text FROM engagement_tasks WHERE tenant_id=${ctx.tenantId}::uuid AND id=${taskId}::uuid FOR UPDATE`;
  const task = await tx.engagementTask.findFirst({ where: { tenantId: ctx.tenantId, id: taskId } });
  if (!task || (task.clientId !== null && selectedClientId !== null && task.clientId !== selectedClientId) ||
      (task.clientId === null && task.ownerUserId !== ctx.userId && !(task.ownerUserId === null && task.createdByUserId === ctx.userId))) throw denied();
  await assertOwnedResearchPortfolioTask(tx, ctx, task);
  if (task.clientId) await visibleClients(tx, ctx, [task.clientId]);
  return task;
}

export function receiveNativeTask(ports: Ports, req: Request, ctx: TenantContext, raw: unknown, mode: 'execute' | 'read') {
  return receiveNativeDatabaseCommand(ports, {
    kind: 'native-task', actions: ['task.create', 'task.update'], validate: validateResult,
    async authorize(_tx, _ctx, p, selected) {
      const clientId = p.command.arguments.clientId;
      if (p.command.action !== 'task.create' || clientId === null) return [];
      if (typeof clientId !== 'string' || !UUID.test(clientId) || selected !== null && clientId !== selected) throw denied();
      return [clientId];
    },
    async check(tx, ctx, p, selected, result) {
      if (result) {
        if (result.clientId) await visibleClients(tx, ctx, [result.clientId]);
        await currentTask(tx, ctx, result.id, selected);
      } else if (p.command.action === 'task.update') await currentTask(tx, ctx, p.command.arguments.taskId as string, selected);
      return result;
    },
    async execute(tx, ctx, p) {
      const args = p.command.arguments;
      const task = p.command.action === 'task.create'
        ? await ports.engagement.createTask(ctx, { title: args.title as string, clientId: args.clientId as string | null ?? undefined,
          dueDate: args.dueDate as string | null ?? undefined, ...(args.clientId === null ? { ownerUserId: ctx.userId } : {}) },
          { tx, sourceType: 'meri_approved_execution', sourceId: p.proposalId + '|' + p.command.idempotencyKey })
        : await ports.engagement.updateTask(ctx, args.taskId as string, args.patch as Parameters<EngagementService['updateTask']>[2], { tx });
      return snapshot(task, p.command.action);
    },
  }, req, ctx, raw, mode);
}
