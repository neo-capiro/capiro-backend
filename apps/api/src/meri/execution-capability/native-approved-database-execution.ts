import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { ClioMeriApprovalDecision, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { loadOwnedActiveClioConversation } from '../../context/application-authority-resource.helpers.js';
import {
  NativeApprovalService,
  nativeDecisionOf,
} from '../native-approvals/native-approval.service.js';
import {
  nativeCanonicalSha256 as hash,
  parseApprovalProposal,
  parseRunBinding,
  sameJson,
  UUID,
  type NativeApprovalProposal,
  type NativeRunBinding,
} from '../native-approvals/native-approval.contract.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import {
  lockMeriExecutionProposal,
  meriExecutionClientsVisible,
  meriExecutionDbNow,
} from './meri-execution-authority.js';

type Ports = {
  prisma: PrismaService;
  approvals: NativeApprovalService;
  tenant: TenantContextMiddleware;
};
export type NativeDatabaseOutcome<R> = {
  execution: {
    kind: string;
    proposalId: string;
    commandSha256: string;
    idempotencyKey: string;
    binding: NativeRunBinding;
    completedAt: string;
    approvalDecisionSha256: string;
  };
  result: R;
};
export type NativeDatabaseNotExecuted = {
  state: 'NOT_EXECUTED';
  proposalId: string;
  commandSha256: string;
  idempotencyKey: string;
  binding: NativeRunBinding;
  reason: 'expired';
  checkedAt: string;
};
/** Closed domain adapters share the approval/session/proposal-lock/receipt owner. */
export interface NativeDatabaseDomain<R extends Record<string, unknown>> {
  kind: 'native-task' | 'native-memory';
  actions: readonly string[];
  userTransaction?: boolean;
  /** Trusted domain-owned transaction boundary; includes the same receipt and release work. */
  transaction?<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
  authorize(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    p: NativeApprovalProposal,
    selected: string | null,
    role: TenantRole,
  ): Promise<string[]>;
  check(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    p: NativeApprovalProposal,
    selected: string | null,
    result?: R,
  ): Promise<R | undefined>;
  execute(tx: Prisma.TransactionClient, ctx: TenantContext, p: NativeApprovalProposal): Promise<R>;
  validate(raw: unknown, p: NativeApprovalProposal): R;
}
const denied = () => new ForbiddenException('Native task authority refused');
const conflict = () =>
  new ConflictException('Native task command differs from its retained decision or outcome');
const unknown = () => new ConflictException('Native task outcome unknown');
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
function outcomeOf<R extends Record<string, unknown>>(
  raw: unknown,
  p: NativeApprovalProposal,
  decisionSha: string,
  decidedAt: Date,
  completedAt: Date,
  domain: NativeDatabaseDomain<R>,
): NativeDatabaseOutcome<R> {
  const v = retainedReadObject(raw, ['execution', 'result']);
  const e = retainedReadObject(v.execution, [
    'kind',
    'proposalId',
    'commandSha256',
    'idempotencyKey',
    'binding',
    'completedAt',
    'approvalDecisionSha256',
  ]);
  if (
    !instant(e.completedAt) ||
    Date.parse(e.completedAt) < Math.max(Date.parse(p.createdAt), decidedAt.getTime()) ||
    e.completedAt !== completedAt.toISOString() ||
    !sameJson(e, {
      kind: domain.kind,
      proposalId: p.proposalId,
      commandSha256: p.commandSha256,
      idempotencyKey: p.command.idempotencyKey,
      binding: p.command.binding,
      completedAt: e.completedAt,
      approvalDecisionSha256: decisionSha,
    })
  )
    throw conflict();
  return {
    execution: e as NativeDatabaseOutcome<R>['execution'],
    result: domain.validate(v.result, p),
  };
}
export async function visibleClients(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  clients: string[],
) {
  const ids = [...new Set(clients)].sort();
  if (!ids.length) return;
  // Hold the actual client and any existing wall grant through receipt commit.
  await tx.$queryRaw`SELECT id::text FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=ANY(${ids}::uuid[]) ORDER BY id FOR SHARE`;
  await tx.$queryRaw`SELECT client_id::text FROM client_memory_access
    WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND client_id=ANY(${ids}::uuid[]) ORDER BY client_id FOR SHARE`;
  if (!(await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, ids))) throw denied();
}

/** Private implementation of the existing execution receiver's native branch.
 * Proposal lock, domain write and immutable receipt commit use one transaction. */
export async function receiveNativeDatabaseCommand<R extends Record<string, unknown>>(
  ports: Ports,
  domain: NativeDatabaseDomain<R>,
  req: Request,
  ctx: TenantContext,
  raw: unknown,
  mode: 'execute' | 'read',
) {
  if (!hasVerifiedToolServiceIdentity(req)) throw denied();
  const input = retainedReadSnapshot(retainedReadObject(raw, ['proposal', 'binding']), 262144);
  const proposal = parseApprovalProposal(input.proposal),
    binding = parseRunBinding(input.binding, 'binding');
  if (
    !domain.actions.includes(proposal.command.action) ||
    !sameJson(binding, proposal.command.binding) ||
    binding.tenantId !== ctx.tenantId ||
    binding.actorId !== ctx.userId ||
    !sameJson(proposal.requiredApprover, { tenantId: ctx.tenantId, actorId: ctx.userId })
  )
    throw denied();
  const prepared = await ports.approvals.verifyPrepared(req, ctx, proposal);
  const session = await ports.tenant.readApplicationAuthoritySession(req, ctx);
  const { command } = proposal,
    args = command.arguments;
  const key = {
    tenantId: ctx.tenantId,
    proposalId: proposal.proposalId,
    idempotencyKey: command.idempotencyKey,
  };
  const transaction = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    domain.transaction
      ? domain.transaction(fn)
      : domain.userTransaction
        ? ports.prisma.withTenantUser(ctx.tenantId, ctx.userId, fn)
        : ports.prisma.withTenant(ctx.tenantId, fn);
  const currentAuthority = async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id::text FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND id=${binding.conversationId}::uuid FOR SHARE`;
    const identity = await session.readCurrent(tx);
    const member = await tx.tenantMembership.findFirst({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' },
      include: { tenant: true },
    });
    if (
      identity.principal.tenantId !== ctx.tenantId ||
      identity.principal.actorId !== ctx.userId ||
      !member ||
      member.tenant.status !== 'active' ||
      !Object.hasOwn(ROLE_RANK, member.role) ||
      ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user
    )
      throw denied();
    const conversation = await loadOwnedActiveClioConversation(
      ports.prisma,
      ctx,
      binding.conversationId,
      tx,
    );
    if (conversation.status !== 'active' || conversation.clientId !== prepared.selectedClientId)
      throw denied();
    if (
      prepared.selectedClientId === null &&
      !(await tx.clioConversationBootstrapReceipt.findFirst({
        where: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          conversationId: binding.conversationId,
          scopeKind: 'general',
          clientId: null,
        },
        select: { requestId: true },
      }))
    )
      throw denied();
    const clients = prepared.selectedClientId === null ? [] : [prepared.selectedClientId];
    clients.push(
      ...(await domain.authorize(
        tx,
        ctx,
        proposal,
        prepared.selectedClientId,
        member.role as TenantRole,
      )),
    );
    await visibleClients(tx, ctx, clients);
    return identity;
  };
  const assertDecision = (decision: ClioMeriApprovalDecision) => {
    if (
      decision.commandSha256 !== proposal.commandSha256 ||
      decision.decision !== 'approved' ||
      decision.approverUserId !== ctx.userId ||
      decision.bindingActorUserId !== ctx.userId ||
      decision.conversationId !== binding.conversationId ||
      decision.runId !== binding.runId ||
      decision.policyRevision !== prepared.policyRevision ||
      decision.expiresAt.getTime() !== Date.parse(proposal.expiresAt) ||
      decision.decidedAt.getTime() < Date.parse(proposal.createdAt)
    )
      throw conflict();
  };
  const result = await transaction(async (tx) => {
    await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
    const identity = await currentAuthority(tx);
    const decision = await tx.clioMeriApprovalDecision.findUnique({
      where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } },
    });
    const existing = await tx.clioMeriExecutionConsumption.findUnique({
      where: { tenantId_proposalId_idempotencyKey: key },
    });
    const assertSession = async () => {
      const current = await session.readCurrent(tx),
        now = await meriExecutionDbNow(tx);
      if (
        !sameJson(current.principal, identity.principal) ||
        current.identityRevision !== identity.identityRevision ||
        Math.min(identity.expiresAtMs, current.expiresAtMs, prepared.expiresAtMs) <= now
      )
        throw denied();
      return now;
    };
    if (decision) assertDecision(decision);
    if (mode === 'read' && !existing) {
      await domain.check(tx, ctx, proposal, prepared.selectedClientId);
      const now = await assertSession();
      if (decision && decision.decidedAt.getTime() > now) throw conflict();
      return {
        kind: 'absent' as const,
        expired: now >= Date.parse(proposal.expiresAt),
        decisionSha256: decision ? hash(nativeDecisionOf(decision)) : null,
        identityRevision: identity.identityRevision,
      };
    }
    if (!decision) throw conflict();
    const decisionSha = hash(nativeDecisionOf(decision));
    if (existing) {
      if (
        existing.jti !== null ||
        existing.commandSha256 !== proposal.commandSha256 ||
        existing.argumentsSha256 !== hash(args)
      )
        throw conflict();
      if (existing.state !== 'COMPLETED' || !existing.result || !existing.completedAt)
        throw unknown();
      const outcome = outcomeOf(
        existing.result,
        proposal,
        decisionSha,
        decision.decidedAt,
        existing.completedAt,
        domain,
      );
      await domain.check(tx, ctx, proposal, prepared.selectedClientId, outcome.result);
      await assertSession();
      return outcome;
    }
    const revocation = await tx.clioMeriApprovalRevocation.findUnique({
      where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } },
    });
    const assertFresh = (now: number) => {
      if (
        revocation ||
        now < Math.max(Date.parse(proposal.createdAt), decision.decidedAt.getTime()) ||
        now >= Math.min(Date.parse(proposal.expiresAt), decision.expiresAt.getTime())
      ) {
        throw new ConflictException('Native task approval is not current');
      }
    };
    assertFresh(await assertSession());
    await domain.check(tx, ctx, proposal, prepared.selectedClientId);
    await tx.clioMeriExecutionConsumption.create({
      data: {
        ...key,
        commandSha256: proposal.commandSha256,
        argumentsSha256: hash(args),
        jti: null,
      },
    });
    assertFresh(await assertSession());
    const written = await domain.execute(tx, ctx, proposal);
    const completedAt = new Date(await assertSession());
    assertFresh(completedAt.getTime());
    const outcome = outcomeOf(
      {
        execution: {
          kind: domain.kind,
          proposalId: proposal.proposalId,
          commandSha256: proposal.commandSha256,
          idempotencyKey: command.idempotencyKey,
          binding,
          completedAt: completedAt.toISOString(),
          approvalDecisionSha256: decisionSha,
        },
        result: written,
      },
      proposal,
      decisionSha,
      decision.decidedAt,
      completedAt,
      domain,
    );
    const done = await tx.clioMeriExecutionConsumption.updateMany({
      where: { ...key, jti: null, state: 'CLAIMED' },
      data: {
        state: 'COMPLETED',
        result: outcome as unknown as Prisma.InputJsonObject,
        completedAt,
      },
    });
    if (done.count !== 1) throw new ServiceUnavailableException('Native task outcome unavailable');
    return outcome;
  });
  // Metadata retention and the attended session remain current at release.
  const released = await ports.approvals.verifyPrepared(req, ctx, proposal);
  if (
    prepared.selectedClientId !== released.selectedClientId ||
    prepared.policyRevision !== released.policyRevision
  )
    throw denied();
  if ('kind' in result)
    return transaction(async (tx) => {
      // Absence is terminal only after expiry and a second locked observation,
      // after the final external metadata/current check. Never infer it from a timeout.
      await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
      const identity = await currentAuthority(tx);
      const decision = await tx.clioMeriApprovalDecision.findUnique({
        where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } },
      });
      const existing = await tx.clioMeriExecutionConsumption.findUnique({
        where: { tenantId_proposalId_idempotencyKey: key },
      });
      if (existing) throw conflict();
      if (decision) assertDecision(decision);
      if ((decision ? hash(nativeDecisionOf(decision)) : null) !== result.decisionSha256)
        throw conflict();
      await domain.check(tx, ctx, proposal, prepared.selectedClientId);
      const current = await session.readCurrent(tx),
        now = await meriExecutionDbNow(tx);
      if (
        !sameJson(current.principal, identity.principal) ||
        current.identityRevision !== identity.identityRevision ||
        current.identityRevision !== result.identityRevision ||
        Math.min(
          identity.expiresAtMs,
          current.expiresAtMs,
          prepared.expiresAtMs,
          released.expiresAtMs,
        ) <= now
      )
        throw denied();
      if (decision && decision.decidedAt.getTime() > now) throw conflict();
      if (!result.expired) return null;
      if (now < Date.parse(proposal.expiresAt)) throw conflict();
      return {
        state: 'NOT_EXECUTED',
        proposalId: proposal.proposalId,
        commandSha256: proposal.commandSha256,
        idempotencyKey: command.idempotencyKey,
        binding,
        reason: 'expired',
        checkedAt: new Date(now).toISOString(),
      } satisfies NativeDatabaseNotExecuted;
    });
  const refreshed = await transaction(async (tx) => {
    const identity = await currentAuthority(tx);
    const freshResult = await domain.check(
      tx,
      ctx,
      proposal,
      prepared.selectedClientId,
      result.result,
    );
    const current = await session.readCurrent(tx);
    if (
      !sameJson(current.principal, identity.principal) ||
      current.identityRevision !== identity.identityRevision ||
      Math.min(identity.expiresAtMs, current.expiresAtMs, released.expiresAtMs) <=
        (await meriExecutionDbNow(tx))
    )
      throw denied();
    return { ...result, result: freshResult ?? result.result };
  });
  return mode === 'read'
    ? { state: 'OUTCOME' as const, outcome: refreshed }
    : { status: 'observed' as const, outcome: refreshed };
}
