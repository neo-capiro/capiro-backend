import { ConflictException, ForbiddenException, GoneException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest, parseManagementRequest,
  type ConversationMetadata, type ManagementReceipt, type ManagementRequest } from './contract.js';

/** Trusted in-process composition only. Never deserialize a fence from HTTP.
 * Meri owns the shared conversation lock, authoritative terminal run check and
 * canonical retention transitions. Missing/remote-unqualified composition is 503.
 * Suppression survives an unknown Core commit; a retry reconciles the same key.
 */
export interface ManagementFence {
  suppress(input: { reason: 'conversation-trash'; restoreUntil: string; requestId: string }): Promise<void>;
  release(input: { reason: 'conversation-restore'; requestId: string }): Promise<void>;
}
export interface ManagementPort {
  withTerminalConversation<T>(input: { principal: { tenantId: string; actorId: string }; conversationId: string;
    requestId: string; operation: ManagementRequest['operation']; expectedRevision: string },
    work: (fence: ManagementFence) => Promise<T>): Promise<T>;
}
export const MERI_CONVERSATION_MANAGEMENT_PORT = Symbol('MERI_CONVERSATION_MANAGEMENT_PORT');
type Tx = Prisma.TransactionClient;
const include = { bootstrapReceipt: true } as const;
export type ManagedRow = Prisma.ClioConversationGetPayload<{ include: typeof include }>;
export async function assertManagedMembership(tx: Tx, ctx: TenantContext) {
  const membership = await tx.tenantMembership.findFirst({ where: { tenantId: ctx.tenantId, userId: ctx.userId,
    status: 'active', tenant: { status: 'active' } }, select: { id: true } });
  if (!membership) throw new ForbiddenException('Current conversation access unavailable');
}
export async function visibleBinding(tx: Tx, ctx: TenantContext, row: ManagedRow) {
  const b = row.bootstrapReceipt;
  if (row.tenantId !== ctx.tenantId || row.userId !== ctx.userId || !b || b.tenantId !== ctx.tenantId ||
      b.actorUserId !== ctx.userId || b.conversationId !== row.id || b.clientId !== row.clientId ||
      b.scopeKind !== (row.clientId === null ? 'general' : 'client')) throw new NotFoundException('Chat not found');
  if (row.clientId !== null) {
    const client = await tx.client.findFirst({ where: { id: row.clientId, tenantId: ctx.tenantId, status: { not: 'archived' },
      OR: [{ memoryWall: false }, { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } }] }, select: { id: true } });
    if (!client) throw new NotFoundException('Chat not found');
  }
}
export function metadata(row: ManagedRow): ConversationMetadata {
  if (!['active', 'archived', 'trashed'].includes(row.status)) throw new NotFoundException('Chat not found');
  return { conversationId: row.id, title: row.title, status: row.status as ConversationMetadata['status'],
    revision: row.metadataRevision.toString(), scopeKind: row.bootstrapReceipt!.scopeKind as 'client' | 'general', clientId: row.clientId,
    updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null,
    trashedAt: row.trashedAt?.toISOString() ?? null, restoreUntil: row.restoreUntil?.toISOString() ?? null };
}

export async function manageConversation(prisma: PrismaService, ctx: TenantContext, raw: unknown, port?: ManagementPort) {
  const request = parseManagementRequest(raw);
  if (!port) throw new ServiceUnavailableException('MANAGEMENT_UNAVAILABLE');
  return port.withTerminalConversation({ principal: { tenantId: ctx.tenantId, actorId: ctx.userId }, ...request }, async fence => {
    let release = false;
    const receipt = await prisma.withTenant(ctx.tenantId, async tx => {
      await assertManagedMembership(tx, ctx);
      // Meri holds the canonical conversation advisory lock for this whole callback.
      await tx.$executeRaw`SELECT id FROM clio_conversations WHERE id=${request.conversationId}::uuid FOR UPDATE`;
      const row = await tx.clioConversation.findFirst({ where: { id: request.conversationId, tenantId: ctx.tenantId, userId: ctx.userId }, include });
      if (!row) throw new NotFoundException('Chat not found');
      await visibleBinding(tx, ctx, row);
      const prior = await tx.clioConversationManagementReceipt.findUnique({ where: {
        tenantId_actorUserId_requestId: { tenantId: ctx.tenantId, actorUserId: ctx.userId, requestId: request.requestId } } });
      if (prior) {
        if (prior.requestSha256 !== managementDigest(request)) throw new ConflictException('REQUEST_ID_CONFLICT');
        if (prior.conversationId !== row.id) throw new GoneException('CONVERSATION_DELETED');
        const stored = prior.receipt as unknown as { receipt: ManagementReceipt; releaseRetention: boolean };
        const saved = stored.receipt;
        // Reconcile only this exact revision. A later Trash must never be undone by an old retry.
        release = request.operation === 'restore' && stored.releaseRetention === true && row.status === 'active' &&
          row.metadataRevision.toString() === saved.conversation.revision;
        return saved;
      }
      if (row.metadataRevision.toString() !== request.expectedRevision) throw new ConflictException('STALE_REVISION');
      const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const now = clock[0]!.now;
      if (row.status === 'trashed' && (!row.restoreUntil || row.restoreUntil <= now)) throw new GoneException('RESTORE_EXPIRED');
      let data: Prisma.ClioConversationUpdateInput = { metadataRevision: { increment: 1 }, updatedAt: now };
      if (request.operation === 'rename') {
        if (row.status === 'trashed') throw new ConflictException('Restore the chat before renaming it');
        data.title = request.title;
      } else if (request.operation === 'archive') {
        if (row.status !== 'active') throw new ConflictException('Chat is not active');
        data = { ...data, status: 'archived', archivedAt: now };
      } else if (request.operation === 'trash') {
        if (row.status === 'trashed') throw new ConflictException('Chat is already in Trash');
        const restoreUntil = new Date(now.getTime() + TRASH_MS);
        await fence.suppress({ reason: 'conversation-trash', restoreUntil: restoreUntil.toISOString(), requestId: request.requestId });
        data = { ...data, status: 'trashed', trashedAt: now, restoreUntil };
      } else {
        if (!['archived', 'trashed'].includes(row.status)) throw new ConflictException('Chat is not archived or in Trash');
        release = row.status === 'trashed';
        data = { ...data, status: 'active', archivedAt: null, trashedAt: null, restoreUntil: null };
      }
      const updated = await tx.clioConversation.update({ where: { id: row.id }, data, include });
      const result: ManagementReceipt = { version: MANAGEMENT_VERSION, requestId: request.requestId, conversation: metadata(updated) };
      await tx.clioConversationManagementReceipt.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId,
        requestId: request.requestId, conversationId: row.id, requestSha256: managementDigest(request),
        receipt: { receipt: result, releaseRetention: release } } });
      return result;
    });
    if (release) await fence.release({ reason: 'conversation-restore', requestId: request.requestId });
    return receipt;
  });
}

/** Trusted runtime composition reads this under its already-held canonical
 * conversation lock. This helper never acquires the Meri advisory lock. */
export async function readManagedConversationMetadata(prisma: PrismaService,
  principal: { tenantId: string; actorId: string }, conversationId: string) {
  return prisma.withTenant(principal.tenantId, async tx => {
    await assertManagedMembership(tx, { tenantId: principal.tenantId, userId: principal.actorId } as TenantContext);
    const row = await tx.clioConversation.findFirst({ where: { id: conversationId,
      tenantId: principal.tenantId, userId: principal.actorId }, include });
    if (!row) throw new NotFoundException('Chat not found');
    await visibleBinding(tx, { tenantId: principal.tenantId, userId: principal.actorId } as TenantContext, row);
    return metadata(row);
  });
}

/** Canonical retention ownership adapter. A caller-supplied actor is never proof
 * of ownership. Visibility remains a separate check for reads and mutations. */
export async function readManagedConversationOwner(prisma: PrismaService,
  input: { tenantId: string; conversationId: string }): Promise<string> {
  return prisma.withTenant(input.tenantId, async tx => {
    const row = await tx.clioConversation.findFirst({ where: { id: input.conversationId, tenantId: input.tenantId }, include });
    const b = row?.bootstrapReceipt;
    if (!row || !b || row.tenantId !== input.tenantId || b.tenantId !== input.tenantId ||
        b.conversationId !== row.id || b.actorUserId !== row.userId || b.clientId !== row.clientId ||
        b.scopeKind !== (row.clientId === null ? 'general' : 'client')) throw new NotFoundException('Chat not found');
    return row.userId;
  });
}

export async function assertLegacyManagementAllowed(tx: Tx, tenantId: string, conversationId: string) {
  const bound = await tx.clioConversationBootstrapReceipt.findFirst({
    where: { tenantId, conversationId }, select: { requestId: true } });
  if (bound) throw new ConflictException('VERSIONED_CONVERSATION_MANAGEMENT_REQUIRED');
}
