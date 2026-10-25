import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { loadOwnedActiveClioConversation } from '../../context/application-authority-resource.helpers.js';
import type { NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { sameJson, type NativeApprovalProposal, type NativeRunBinding } from '../native-approvals/native-approval.contract.js';
import { lockMeriExecutionProposal, meriExecutionClientsVisible, meriExecutionDbNow } from './meri-execution-authority.js';

type Ports = { prisma: PrismaService; approvals: NativeApprovalService; tenant: TenantContextMiddleware };
const denied = () => new ForbiddenException('Native filing authority refused');
const conflict = () => new ConflictException('Native filing differs from its retained decision or outcome');

/** The existing filing receiver's current authority checks, shared with its
 * DB-only original registration. Approval and current access keep their owners. */
export async function prepareNativeArtifactFileAuthority(ports: Ports, req: Request, ctx: TenantContext,
  proposal: NativeApprovalProposal, binding: NativeRunBinding) {
  if (!hasVerifiedToolServiceIdentity(req) || proposal.command.action !== 'artifact.file' ||
      !sameJson(binding, proposal.command.binding) || binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
      !sameJson(proposal.requiredApprover, { tenantId: ctx.tenantId, actorId: ctx.userId })) throw denied();
  const clientId = proposal.command.arguments.clientId as string;
  const prepared = await ports.approvals.verifyPrepared(req, ctx, proposal);
  if (prepared.selectedClientId !== clientId || !clientId || proposal.command.arguments.conversationId !== binding.conversationId) throw denied();
  const session = await ports.tenant.readApplicationAuthoritySession(req, ctx);
  const authorize = async (tx: Prisma.TransactionClient, fresh: boolean) => {
    await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
    await tx.$queryRaw`SELECT id::text FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND id=${binding.conversationId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=${clientId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT client_id::text FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND client_id=${clientId}::uuid FOR SHARE`;
    const current = await session.readCurrent(tx), now = await meriExecutionDbNow(tx);
    const member = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, include: { tenant: true } });
    const conversation = await loadOwnedActiveClioConversation(ports.prisma, ctx, binding.conversationId, tx);
    if (current.principal.tenantId !== ctx.tenantId || current.principal.actorId !== ctx.userId ||
        Math.min(current.expiresAtMs, prepared.expiresAtMs) <= now || !member || member.tenant.status !== 'active' ||
        !Object.hasOwn(ROLE_RANK, member.role) || ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user ||
        conversation.status !== 'active' || conversation.clientId !== clientId ||
        !await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, [clientId])) throw denied();
    const decision = await tx.clioMeriApprovalDecision.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
    if (!decision) return null;
    if (decision.commandSha256 !== proposal.commandSha256 || decision.decision !== 'approved' || decision.approverUserId !== ctx.userId ||
        decision.bindingActorUserId !== ctx.userId || decision.conversationId !== binding.conversationId || decision.runId !== binding.runId ||
        decision.policyRevision !== prepared.policyRevision || decision.expiresAt.getTime() !== Date.parse(proposal.expiresAt) ||
        decision.decidedAt.getTime() < Date.parse(proposal.createdAt)) throw conflict();
    if (fresh) {
      const revoked = await tx.clioMeriApprovalRevocation.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
      if (revoked || now < Math.max(Date.parse(proposal.createdAt), decision.decidedAt.getTime()) ||
          now >= Math.min(Date.parse(proposal.expiresAt), decision.expiresAt.getTime())) throw conflict();
    }
    return decision;
  };
  const readCurrent = async () => {
    const current = await ports.approvals.verifyPrepared(req, ctx, proposal);
    if (current.selectedClientId !== clientId || current.policyRevision !== prepared.policyRevision) throw denied();
    return current;
  };
  return { clientId, authorize, readCurrent };
}
