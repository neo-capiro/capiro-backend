import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ROLE_RANK, type TenantContext, type TenantRole } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { EngagementService } from '../../engagement/engagement.service.js';
import type { TenantContextMiddleware } from '../../tenant/tenant-context.middleware.js';
import { SingleMailLedger, singleMailHash } from '../../engagement/single-mail-ledger.js';
import { ownedSendingMailboxWhere } from '../../engagement/mailbox-selection.js';
import { mailReplyAddress } from '../../engagement/mail-reply-recipients.js';
import { hasVerifiedToolServiceIdentity } from '../../auth/tool-service-secret.guard.js';
import { loadOwnedActiveClioConversation } from '../../context/application-authority-resource.helpers.js';
import { nativeDecisionOf, type NativeApprovalService } from '../native-approvals/native-approval.service.js';
import { nativeCanonicalSha256 as hash, parseApprovalProposal, parseRunBinding, sameJson } from '../native-approvals/native-approval.contract.js';
import { retainedReadObject, retainedReadSnapshot } from '../retained-read-context.js';
import { lockMeriExecutionProposal, meriExecutionClientsVisible, meriExecutionDbNow } from './meri-execution-authority.js';
import { nativeMailInput, nativeMailResult, parseNativeMailArguments } from './native-mail-command.js';

type Ports = { prisma: PrismaService; engagement: EngagementService; approvals: NativeApprovalService; tenant: TenantContextMiddleware };
const denied = () => new ForbiddenException('Native mail authority refused');
const conflict = () => new ConflictException('Native mail differs from its retained decision or attempt');

/** The native approval receiver delegates the irreversible boundary to SingleMailLedger.
 * No execution-consumption row, retry, provider request or second send ledger lives here. */
export async function receiveNativeMail(ports: Ports, req: Request, ctx: TenantContext, raw: unknown, mode: 'execute' | 'read') {
  if (!hasVerifiedToolServiceIdentity(req)) throw denied();
  const body = retainedReadSnapshot(retainedReadObject(raw, ['proposal', 'binding']), 262144);
  const proposal = parseApprovalProposal(body.proposal), binding = parseRunBinding(body.binding, 'binding');
  if (proposal.command.action !== 'mail.send' || !sameJson(binding, proposal.command.binding) ||
      binding.tenantId !== ctx.tenantId || binding.actorId !== ctx.userId ||
      !sameJson(proposal.requiredApprover, { tenantId: ctx.tenantId, actorId: ctx.userId })) throw denied();
  const args = parseNativeMailArguments(proposal.command.arguments), input = nativeMailInput(args, proposal.proposalId);
  const prepared = await ports.approvals.verifyPrepared(req, ctx, proposal);
  if (prepared.selectedClientId !== null && args.clientId !== prepared.selectedClientId) throw denied();
  const session = await ports.tenant.readApplicationAuthoritySession(req, ctx);
  let identityRevision: string | undefined;
  const authorize = async (tx: Prisma.TransactionClient, fresh: boolean) => {
    // Same lock as approval revocation; held through the mail pending->sending commit.
    await lockMeriExecutionProposal(tx, ctx.tenantId, proposal.proposalId);
    await tx.$queryRaw`SELECT id::text FROM users WHERE id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenants WHERE id=${ctx.tenantId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM tenant_memberships WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id::text FROM clio_conversations WHERE tenant_id=${ctx.tenantId}::uuid AND id=${binding.conversationId}::uuid FOR SHARE`;
    const identity = await session.readCurrent(tx), now = await meriExecutionDbNow(tx);
    const member = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active' }, include: { tenant: true } });
    const conversation = await loadOwnedActiveClioConversation(ports.prisma, ctx, binding.conversationId, tx);
    if (identity.principal.tenantId !== ctx.tenantId || identity.principal.actorId !== ctx.userId ||
        identityRevision !== undefined && identity.identityRevision !== identityRevision ||
        Math.min(identity.expiresAtMs, prepared.expiresAtMs) <= now || !member || member.tenant.status !== 'active' ||
        !Object.hasOwn(ROLE_RANK, member.role) || ROLE_RANK[member.role as TenantRole] < ROLE_RANK.standard_user ||
        conversation.status !== 'active' || conversation.clientId !== prepared.selectedClientId) throw denied();
    identityRevision ??= identity.identityRevision;
    if (prepared.selectedClientId === null && !await tx.clioConversationBootstrapReceipt.findFirst({
      where: { tenantId: ctx.tenantId, actorUserId: ctx.userId, conversationId: binding.conversationId, scopeKind: 'general', clientId: null },
      select: { requestId: true },
    })) throw denied();
    const clients = [...new Set([prepared.selectedClientId, args.clientId].filter((v): v is string => v !== null))].sort();
    if (clients.length) {
      await tx.$queryRaw`SELECT id::text FROM clients WHERE tenant_id=${ctx.tenantId}::uuid AND id=ANY(${clients}::uuid[]) ORDER BY id FOR SHARE`;
      await tx.$queryRaw`SELECT client_id::text FROM client_memory_access WHERE tenant_id=${ctx.tenantId}::uuid AND user_id=${ctx.userId}::uuid AND client_id=ANY(${clients}::uuid[]) ORDER BY client_id FOR SHARE`;
      if (!await meriExecutionClientsVisible(tx, ctx.tenantId, ctx.userId, clients)) throw denied();
    }
    await tx.$queryRaw`SELECT id::text FROM engagement_connections WHERE tenant_id=${ctx.tenantId}::uuid AND id=${args.senderConnectionId}::uuid FOR SHARE`;
    const mailbox = await tx.integrationConnection.findFirst({ where: { ...(fresh ? ownedSendingMailboxWhere(ctx) :
      { tenantId: ctx.tenantId, createdByUserId: ctx.userId }), id: args.senderConnectionId }, select: { id: true, accountEmail: true } });
    if (!mailbox || fresh && mailReplyAddress(mailbox.accountEmail ?? '') !== args.senderEmail) throw denied();
    const decision = await tx.clioMeriApprovalDecision.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
    if (!decision) { if (fresh) throw denied(); return null; }
    if (decision.commandSha256 !== proposal.commandSha256 || decision.decision !== 'approved' || decision.approverUserId !== ctx.userId ||
        decision.bindingActorUserId !== ctx.userId || decision.conversationId !== binding.conversationId || decision.runId !== binding.runId ||
        decision.policyRevision !== prepared.policyRevision || decision.expiresAt.getTime() !== Date.parse(proposal.expiresAt) ||
        decision.decidedAt.getTime() < Date.parse(proposal.createdAt) || decision.decidedAt.getTime() > now) throw conflict();
    if (fresh) {
      const revoked = await tx.clioMeriApprovalRevocation.findUnique({ where: { tenantId_proposalId: { tenantId: ctx.tenantId, proposalId: proposal.proposalId } } });
      if (revoked || now < Date.parse(proposal.createdAt) || now >= Math.min(Date.parse(proposal.expiresAt), decision.expiresAt.getTime())) throw denied();
    }
    return decision;
  };
  const decision = await ports.prisma.withTenant(ctx.tenantId, tx => authorize(tx, false));
  const ledger = new SingleMailLedger(ports.prisma);
  const provenance = decision ? { kind: 'native-mail' as const, proposalId: proposal.proposalId, commandSha256: proposal.commandSha256,
    idempotencyKey: proposal.command.idempotencyKey, binding, approvalDecisionSha256: hash(nativeDecisionOf(decision)) } : null;
  const readAttempt = async () => {
    const row = await ledger.read(ctx, proposal.proposalId);
    if (!row) return null;
    if (!provenance || !sameJson(row.snapshot.nativeApproval, provenance)) throw conflict();
    ledger.assertRequest(row, singleMailHash({ input, nativeApproval: provenance }));
    // The domain reader retains current mailbox/client/wall checks and allows
    // deleted original bodies only where the durable read owner already does.
    return ports.engagement.getSingleMailIntent(ctx, proposal.proposalId);
  };
  let attempt = await readAttempt();
  if (!attempt && mode === 'execute') {
    if (!provenance) throw denied();
    await ports.prisma.withTenant(ctx.tenantId, tx => authorize(tx, true));
    try {
      await ports.engagement.sendSingleMail(ctx, input, { provenance, authorize: async (tx, payload) => {
        const expected = args.files.map(f => ({ name: f.fileName, contentType: f.contentType, bytes: f.bytes, sha256: f.sha256 }));
        if (!sameJson(payload.attachments.map(hash).sort(), expected.map(hash).sort())) throw denied();
        if (args.files.length) {
          const rows = await tx.engagementAttachment.findMany({ where: { tenantId: ctx.tenantId, id: { in: args.files.map(f => f.attachmentId) } },
            select: { id: true, fileName: true, contentType: true, byteSize: true, calculatedSha256: true } });
          if (rows.length !== args.files.length || args.files.some(f => !rows.some(r => r.id === f.attachmentId &&
              r.fileName === f.fileName && r.contentType === f.contentType && r.byteSize === f.bytes && r.calculatedSha256 === f.sha256))) throw denied();
        }
        const current = await authorize(tx, true);
        if (!current || hash(nativeDecisionOf(current)) !== provenance.approvalDecisionSha256) throw denied();
      } });
    } catch (error) {
      // A transport/callback failure is not certainty. Only the canonical
      // committed row below may establish accepted, failed, or fenced UNKNOWN.
      attempt = await readAttempt();
      if (!attempt) throw error;
    }
    attempt = await readAttempt();
  }
  const released = await ports.approvals.verifyPrepared(req, ctx, proposal);
  if (released.selectedClientId !== prepared.selectedClientId || released.policyRevision !== prepared.policyRevision) throw denied();
  await ports.prisma.withTenant(ctx.tenantId, async tx => {
    const current = await authorize(tx, false);
    if ((current ? hash(nativeDecisionOf(current)) : null) !== (provenance?.approvalDecisionSha256 ?? null) ||
        released.expiresAtMs <= await meriExecutionDbNow(tx)) throw denied();
  });
  if (!attempt) return mode === 'read' ? null : { status: 'indeterminate' as const };
  // Read authority again after the final external metadata lookup; never resend.
  attempt = await readAttempt();
  if (!attempt) throw conflict();
  const result = nativeMailResult(attempt, args, proposal.proposalId);
  if (!result) return mode === 'read' ? { state: 'UNKNOWN' as const } : { status: 'indeterminate' as const };
  const outcome = { execution: provenance!, result };
  return mode === 'read' ? { state: 'OUTCOME' as const, outcome } : { status: 'observed' as const, outcome };
}
