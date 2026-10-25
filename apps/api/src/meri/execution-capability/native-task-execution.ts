import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { ClioMeriApprovalDecision, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EngagementService } from '../../engagement/engagement.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { loadOwnedActiveClioConversation } from '../../context/application-authority-resource.helpers.js';
import { assertOwnedResearchPortfolioTask } from '../../engagement/research-portfolio-task-access.js';
import { NativeApprovalService, nativeDecisionOf } from '../native-approvals/native-approval.service.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal, parseRunBinding, sameJson, UUID,
  type NativeApprovalProposal, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import { lockMeriExecutionProposal, meriExecutionClientsVisible, meriExecutionDbNow } from './meri-execution-authority.js';

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
const unknown = () => new ConflictException('Native task outcome unknown');
const instant = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const statuses = ['todo', 'in_progress', 'done', 'blocked', 'canceled'];

function snapshot(task: Task, action: string): TaskResult {
  return { id: task.id, title: task.title, status: task.status, dueDate: task.dueDate?.toISOString() ?? null,
    clientId: task.clientId, ...(action === 'task.create' ? { createdAt: task.createdAt.toISOString() } : { updatedAt: task.updatedAt.toISOString() }) };
}

/** Validate immutable historical result, not the task's mutable current title/status. */
function outcomeOf(raw: unknown, p: NativeApprovalProposal, decisionSha: string, decidedAt: Date, completedAt: Date): NativeTaskOutcome {
  const v = retainedReadObject(raw, ['execution', 'result']);
  const e = retainedReadObject(v.execution, ['kind', 'proposalId', 'commandSha256', 'idempotencyKey', 'binding', 'completedAt', 'approvalDecisionSha256']);
  const timeField = p.command.action === 'task.create' ? 'createdAt' : 'updatedAt';
  const r = retainedReadObject(v.result, ['id', 'title', 'status', 'dueDate', 'clientId', timeField]);
  if (!instant(e.completedAt) || Date.parse(e.completedAt) < Math.max(Date.parse(p.createdAt), decidedAt.getTime()) ||
      e.completedAt !== completedAt.toISOString() || !sameJson(e, { kind: 'native-task', proposalId: p.proposalId,
        commandSha256: p.commandSha256, idempotencyKey: p.command.idempotencyKey, binding: p.command.binding,
        completedAt: e.completedAt, approvalDecisionSha256: decisionSha }) ||
      typeof r.id !== 'string' || !UUID.test(r.id) || typeof r.title !== 'string' || !statuses.includes(String(r.status)) ||
      (r.clientId !== null && (typeof r.clientId !== 'string' || !UUID.test(r.clientId))) || !instant(r[timeField]) ||
      (r.dueDate !== null && (!instant(r.dueDate) || Date.parse(r.dueDate) % 86400000 !== 0))) throw conflict();
  const args = p.command.arguments;
  if (p.command.action === 'task.create') {
    if (r.status !== 'todo' || !['title', 'clientId', 'dueDate'].every(k => r[k] === args[k])) throw conflict();
  } else if (r.id !== args.taskId || !Object.entries(args.patch as Record<string, unknown>).every(([k, value]) => r[k] === value)) throw conflict();
  return v as unknown as NativeTaskOutcome;
}

async function visibleClients(tx: Prisma.TransactionClient, ctx: TenantContext, clients: string[]) {
  const ids = [...new Set(clients)].sort();
  if (!ids.length) return;
  // Hold the actual client and any existing wall grant through receipt commit.
  await tx.$queryRaw`SELECT id::text FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT client_id::text FROM client_memory_access
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND client_id=ANY(${ids}::uuid[]) ORDER BY client_id FOR SHARE`;
  if (!(await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, ids))) throw denied();
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

/** Private implementation of the existing execution receiver's native branch.
 * Proposal lock, domain write and immutable receipt commit use one transaction. */
export async function receiveNativeTask(ports: Ports, req: Request, ctx: TenantContext, raw: unknown, mode: 'execute' | 'read') {
  if (!hasVerifiedToolServiceIdentity(req)) throw denied();
  const input = retainedReadSnapshot(retainedReadObject(raw, ['proposal', 'binding']), 262144);
  const proposal = parseApprovalProposal(input.proposal), binding = parseRunBinding(input.binding, 'binding');
  if (!['task.create', 'task.update'].includes(proposal.command.action) || !sameJson(binding, proposal.command.binding) ||
      binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
      !sameJson(proposal.requiredApprover, { tenantId: ctx.tenantId, actorId: ctx.userId })) throw denied();
  const prepared = await ports.approvals.verifyPrepared(req, ctx, proposal);
  const session = await ports.tenant.readApplicationAuthoritySession(req, ctx);
  const { command } = proposal, args = command.arguments;
  const key = { tenantId: ctx.tenantId, proposalId: proposal.proposalId, idempotencyKey: command.idempotencyKey };
  const currentAuthority = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id::text FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND id=${binding.conversationId}::uuid FOR SHARE`;
    const identity = await session.readCurrent(tx);
    const member = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, include: { tenant: true } });
    if (identity.principal.tenantId !== ctx.tenantId || identity.principal.actorId !== ctx.userId ||
        !member || member.tenant.status !== 'active' || !Object.hasOwn(ROLE_RANK, member.role) ||
        ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user) throw denied();
    const conversation = await loadOwnedActiveClioConversation(ports.prisma, ctx, binding.conversationId, tx);
    if (conversation.status !== 'active' || conversation.clientId !== prepared.selectedClientId) throw denied();
    if (prepared.selectedClientId === null && !(await tx.clioConversationBootstrapReceipt.findFirst({
      where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, conversationId: binding.conversationId, scopeKind: 'general', clientId: null },
      select: { requestId: true },
    }))) throw denied();
    const clients = prepared.selectedClientId === null ? [] : [prepared.selectedClientId];
    if (command.action === 'task.create' && args.clientId !== null) {
      if (typeof args.clientId !== 'string' || !UUID.test(args.clientId) || prepared.selectedClientId !== null && args.clientId !== prepared.selectedClientId) throw denied();
      clients.push(args.clientId);
    }
    await visibleClients(tx, ctx, clients);
    return identity;
  };
  const assertDecision = (decision: ClioMeriApprovalDecision) => {
    if (decision.commandSha256 !== proposal.commandSha256 || decision.decision !== 'approved' ||
        decision.approverUserId !== ctx.userId || decision.bindingActorUserId !== ctx.userId ||
        decision.conversationId !== binding.conversationId || decision.runId !== binding.runId ||
        decision.policyRevision !== prepared.policyRevision || decision.expiresAt.getTime() !== Date.parse(proposal.expiresAt) ||
        decision.decidedAt.getTime() < Date.parse(proposal.createdAt)) throw conflict();
  };
  const result = await ports.prisma.withTenant(ctx.tenantId, async tx => {
    await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
    const identity = await currentAuthority(tx);
    const decision = await tx.clioMeriApprovalDecision.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
    const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
    const assertSession = async () => {
      const current = await session.readCurrent(tx), now = await meriExecutionDbNow(tx);
      if (!sameJson(current.principal, identity.principal) || current.identityRevision !== identity.identityRevision ||
          Math.min(identity.expiresAtMs, current.expiresAtMs, prepared.expiresAtMs) <= now) throw denied();
      return now;
    };
    if (decision) assertDecision(decision);
    if (mode === 'read' && !existing) {
      if (command.action === 'task.update') await currentTask(tx, ctx, args.taskId as string, prepared.selectedClientId);
      const now = await assertSession();
      if (decision && decision.decidedAt.getTime() > now) throw conflict();
      return { kind: 'absent' as const, expired: now >= Date.parse(proposal.expiresAt),
        decisionSha256: decision ? hash(nativeDecisionOf(decision)) : null, identityRevision: identity.identityRevision };
    }
    if (!decision) throw conflict();
    const decisionSha = hash(nativeDecisionOf(decision));
    if (existing) {
      if (existing.jti !== null || existing.commandSha256 !== proposal.commandSha256 || existing.argumentsSha256 !== hash(args)) throw conflict();
      if (existing.state !== 'COMPLETED' || !existing.result || !existing.completedAt) throw unknown();
      const outcome = outcomeOf(existing.result, proposal, decisionSha, decision.decidedAt, existing.completedAt);
      // Historical snapshots retain their own client classification; current task
      // ownership/walls are checked separately before releasing that snapshot.
      if (outcome.result.clientId) await visibleClients(tx, ctx, [outcome.result.clientId]);
      await currentTask(tx, ctx, outcome.result.id, prepared.selectedClientId);
      await assertSession();
      return outcome;
    }
    const revocation = await tx.clioMeriApprovalRevocation.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
    const assertFresh = (now: number) => {
      if (revocation || now < Math.max(Date.parse(proposal.createdAt), decision.decidedAt.getTime()) ||
          now >= Math.min(Date.parse(proposal.expiresAt), decision.expiresAt.getTime())) {
        throw new ConflictException('Native task approval is not current');
      }
    };
    assertFresh(await assertSession());
    if (command.action === 'task.update') await currentTask(tx, ctx, args.taskId as string, prepared.selectedClientId);
    await tx.clioMeriExecutionConsumption.create({ data: { ...key, commandSha256: proposal.commandSha256, argumentsSha256: hash(args), jti: null } });
    assertFresh(await assertSession());
    const task = command.action === 'task.create'
      ? await ports.engagement.createTask(ctx, { title: args.title as string, clientId: args.clientId as string | null ?? undefined,
        dueDate: args.dueDate as string | null ?? undefined, ...(args.clientId === null ? { ownerUserId: ctx.userId } : {}) },
      { tx, sourceType: 'meri_approved_execution', sourceId: `${proposal.proposalId}|${command.idempotencyKey}` })
      : await ports.engagement.updateTask(ctx, args.taskId as string,
        args.patch as Parameters<EngagementService['updateTask']>[2], { tx });
    const completedAt = new Date(await assertSession());
    assertFresh(completedAt.getTime());
    const outcome = outcomeOf({ execution: { kind: 'native-task', proposalId: proposal.proposalId,
      commandSha256: proposal.commandSha256, idempotencyKey: command.idempotencyKey, binding,
      completedAt: completedAt.toISOString(), approvalDecisionSha256: decisionSha }, result: snapshot(task, command.action) },
    proposal, decisionSha, decision.decidedAt, completedAt);
    const done = await tx.clioMeriExecutionConsumption.updateMany({ where: { ...key, jti: null, state: 'CLAIMED' },
      data: { state: 'COMPLETED', result: outcome as unknown as Prisma.InputJsonObject, completedAt } });
    if (done.count !== 1) throw new ServiceUnavailableException('Native task outcome unavailable');
    return outcome;
  });
  // Metadata retention and the attended session remain current at release.
  const released = await ports.approvals.verifyPrepared(req, ctx, proposal);
  if (prepared.selectedClientId !== released.selectedClientId || prepared.policyRevision !== released.policyRevision) throw denied();
  if ('kind' in result) return ports.prisma.withTenant(ctx.tenantId, async tx => {
    // Absence is terminal only after expiry and a second locked observation,
    // after the final external metadata/current check. Never infer it from a timeout.
    await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
    const identity = await currentAuthority(tx);
    const decision = await tx.clioMeriApprovalDecision.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
    const existing = await tx.clioMeriExecutionConsumption.findUnique({ where: { tenantId_proposalId_idempotencyKey: key } });
    if (existing) throw conflict();
    if (decision) assertDecision(decision);
    if ((decision ? hash(nativeDecisionOf(decision)) : null) !== result.decisionSha256) throw conflict();
    if (command.action === 'task.update') await currentTask(tx, ctx, args.taskId as string, prepared.selectedClientId);
    const current = await session.readCurrent(tx), now = await meriExecutionDbNow(tx);
    if (!sameJson(current.principal, identity.principal) || current.identityRevision !== identity.identityRevision ||
        current.identityRevision !== result.identityRevision ||
        Math.min(identity.expiresAtMs, current.expiresAtMs, prepared.expiresAtMs, released.expiresAtMs) <= now) throw denied();
    if (decision && decision.decidedAt.getTime() > now) throw conflict();
    if (!result.expired) return null;
    if (now < Date.parse(proposal.expiresAt)) throw conflict();
    return { state: 'NOT_EXECUTED', proposalId: proposal.proposalId, commandSha256: proposal.commandSha256,
      idempotencyKey: command.idempotencyKey, binding, reason: 'expired', checkedAt: new Date(now).toISOString() } satisfies NativeTaskNotExecuted;
  });
  await ports.prisma.withTenant(ctx.tenantId, async tx => {
    // A General proposal carries no destination client in its scopes. Recheck
    // the actual task after the last external metadata/current lookup as well.
    const current = await session.readCurrent(tx);
    const conversation = await loadOwnedActiveClioConversation(ports.prisma, ctx, binding.conversationId, tx);
    if (conversation.status !== 'active' || conversation.clientId !== prepared.selectedClientId) throw denied();
    if (result.result.clientId) await visibleClients(tx, ctx, [result.result.clientId]);
    await currentTask(tx, ctx, result.result.id, prepared.selectedClientId);
    if (Math.min(current.expiresAtMs, released.expiresAtMs) <= await meriExecutionDbNow(tx)) throw denied();
  });
  return mode === 'read' ? { state: 'OUTCOME' as const, outcome: result } : { status: 'observed' as const, outcome: result };
}
