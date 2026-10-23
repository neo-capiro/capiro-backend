import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { TRASH_MS } from './contract.js';

export type ConversationRetentionIdentity = {
  tenantId: string; conversationId: string; ownerActorId: string; bootstrapRequestId: string;
  scope: { kind: 'general'; clientId: null } | { kind: 'client'; clientId: string };
};
export type ConversationRetentionState = {
  version: 'meri.conversation-retention.v1'; identity: ConversationRetentionIdentity;
  status: 'active' | 'archived' | 'trashed'; revision: string;
  trashedAt: string | null; restoreUntil: string | null;
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const unavailable = () => new NotFoundException('Conversation retention identity unavailable');

/** Content-free facts for the existing trusted retention composition only.
 * No route mounts this reader. These facts grant neither serving nor deletion;
 * the canonical purger still owns current policy, holds, generation and locks.
 * Scheduled retention deliberately does not depend on the departed owner's
 * interactive membership or client wall. Interactive metadata is unchanged.
 */
export async function readConversationRetentionState(prisma: PrismaService,
  input: { tenantId: string; conversationId: string }): Promise<ConversationRetentionState> {
  if (!input || Object.keys(input).sort().join() !== 'conversationId,tenantId' ||
      !validId(input.tenantId) || !validId(input.conversationId)) throw new BadRequestException('Invalid retention subject');
  return prisma.withTenant(input.tenantId, async tx => {
    const row = await tx.clioConversation.findFirst({
      where: { tenantId: input.tenantId, id: input.conversationId },
      select: { id: true, tenantId: true, userId: true, clientId: true, status: true, metadataRevision: true,
        archivedAt: true, trashedAt: true, restoreUntil: true,
        bootstrapReceipt: { select: { tenantId: true, actorUserId: true, requestId: true,
          conversationId: true, clientId: true, scopeKind: true } } },
    });
    const binding = row?.bootstrapReceipt;
    if (!row || !binding || row.id !== input.conversationId || row.tenantId !== input.tenantId ||
        !validId(row.userId) || !validId(binding.requestId) || binding.tenantId !== row.tenantId ||
        binding.actorUserId !== row.userId || binding.conversationId !== row.id || binding.clientId !== row.clientId)
      throw unavailable();
    let scope: ConversationRetentionIdentity['scope'];
    if (binding.scopeKind === 'general' && row.clientId === null) scope = { kind: 'general', clientId: null };
    else if (binding.scopeKind === 'client' && validId(row.clientId)) scope = { kind: 'client', clientId: row.clientId };
    else throw unavailable();
    if (typeof row.metadataRevision !== 'bigint' || !/^(0|[1-9][0-9]{0,17})$/.test(row.metadataRevision.toString()) ||
        !['active', 'archived', 'trashed'].includes(row.status) ||
        (row.archivedAt !== null && !date(row.archivedAt))) throw unavailable();
    if (row.status === 'trashed') {
      if (!date(row.trashedAt) || !date(row.restoreUntil) ||
          row.restoreUntil.getTime() - row.trashedAt.getTime() !== TRASH_MS) throw unavailable();
    } else if (row.trashedAt !== null || row.restoreUntil !== null ||
        (row.status === 'active' && row.archivedAt !== null) ||
        (row.status === 'archived' && !date(row.archivedAt))) throw unavailable();
    return { version: 'meri.conversation-retention.v1',
      identity: { tenantId: row.tenantId, conversationId: row.id, ownerActorId: row.userId,
        bootstrapRequestId: binding.requestId, scope },
      status: row.status as ConversationRetentionState['status'], revision: row.metadataRevision.toString(),
      trashedAt: row.trashedAt?.toISOString() ?? null, restoreUntil: row.restoreUntil?.toISOString() ?? null };
  });
}
