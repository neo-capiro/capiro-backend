import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '@prisma/client';
import { lockMemoryRetentionInTx } from '../../memory/memory-retention-selection.js';
import { conversationMemoryCandidatesInTx, purgeConversationMemoryInTx } from '../../memory/memory-conversation-retention.js';
import { eraseConversationOfficeDraftsInTx, hasConversationOfficeDraftsInTx } from '../office-drafts/retention.js';
import { MANAGEMENT_VERSION, TRASH_MS, managementDigest, type ManagementReceipt } from './contract.js';
import { consumedDeletionMatches } from './deletion-receipt.js';

export type ConversationRetentionIdentity = {
  tenantId: string; conversationId: string; ownerActorId: string; bootstrapRequestId: string;
  scope: { kind: 'general'; clientId: null } | { kind: 'client'; clientId: string };
};
export type ConversationRetentionState = {
  version: 'meri.conversation-retention.v1'; identity: ConversationRetentionIdentity;
  status: 'active' | 'archived' | 'trashed'; revision: string;
  trashedAt: string | null; restoreUntil: string | null;
  trashRequestId: string | null; checkedAtMs: number;
};
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const validId = (value: unknown): value is string => typeof value === 'string' && uuid.test(value);
const date = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
const unavailable = () => new NotFoundException('Conversation retention identity unavailable');

/** Content-free facts for the existing trusted retention composition only.
 * These facts grant neither serving nor deletion; the canonical purger still
 * owns current policy, holds, generation and locks.
 * Scheduled retention deliberately does not depend on the departed owner's
 * interactive membership or client wall. Interactive metadata is unchanged.
 */
export async function readConversationRetentionState(prisma: PrismaService,
  input: { tenantId: string; conversationId: string }): Promise<ConversationRetentionState> {
  if (!input || Object.keys(input).sort().join() !== 'conversationId,tenantId' ||
      !validId(input.tenantId) || !validId(input.conversationId)) throw new BadRequestException('Invalid retention subject');
  return prisma.withTenant(input.tenantId, async tx => {
    // The short read transaction prevents Restore from changing the generation
    // between the metadata and its immutable receipt. No external IO is held.
    await tx.$executeRaw`SELECT id FROM clio_conversations WHERE tenant_id=${input.tenantId}::uuid
      AND id=${input.conversationId}::uuid FOR SHARE`;
    return retentionState(tx, input);
  });
}

async function retentionState(tx: Prisma.TransactionClient,
  input: { tenantId: string; conversationId: string }): Promise<ConversationRetentionState> {
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
    let trashRequestId: string | null = null;
    if (row.status === 'trashed') {
      if (!date(row.trashedAt) || !date(row.restoreUntil) ||
          !date(row.archivedAt) || row.metadataRevision < 1n ||
          row.restoreUntil.getTime() - row.trashedAt.getTime() !== TRASH_MS) throw unavailable();
      const receipts = await tx.clioConversationManagementReceipt.findMany({ where: {
        tenantId: row.tenantId, actorUserId: row.userId, conversationId: row.id,
        receipt: { path: ['receipt', 'conversation', 'revision'], equals: row.metadataRevision.toString() },
      }, take: 2 });
      const prior = receipts[0];
      const saved = prior?.receipt as unknown as { receipt?: ManagementReceipt; releaseRetention?: boolean; suppressionRequestId?: unknown };
      const receipt = saved?.receipt, conversation = receipt?.conversation;
      if (receipts.length !== 1 || !prior || !validId(prior.requestId) ||
          prior.tenantId !== row.tenantId || prior.actorUserId !== row.userId || prior.conversationId !== row.id ||
          receipt?.version !== MANAGEMENT_VERSION || receipt.requestId !== prior.requestId ||
          saved.releaseRetention !== false || saved.suppressionRequestId !== null ||
          conversation?.conversationId !== row.id || conversation.status !== 'trashed' ||
          conversation.revision !== row.metadataRevision.toString() || conversation.scopeKind !== scope.kind ||
          conversation.clientId !== row.clientId || conversation.trashedAt !== row.trashedAt.toISOString() ||
          conversation.restoreUntil !== row.restoreUntil.toISOString() ||
          prior.requestSha256 !== managementDigest({ version: MANAGEMENT_VERSION, operation: 'trash',
            requestId: prior.requestId, conversationId: row.id, expectedRevision: (row.metadataRevision - 1n).toString() }))
        throw unavailable();
      trashRequestId = prior.requestId;
    } else if (row.trashedAt !== null || row.restoreUntil !== null ||
        (row.status === 'active' && row.archivedAt !== null) ||
        (row.status === 'archived' && !date(row.archivedAt))) throw unavailable();
    const clocks = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    if (clocks.length !== 1 || !date(clocks[0]?.now)) throw unavailable();
    return { version: 'meri.conversation-retention.v1',
      identity: { tenantId: row.tenantId, conversationId: row.id, ownerActorId: row.userId,
        bootstrapRequestId: binding.requestId, scope },
      status: row.status as ConversationRetentionState['status'], revision: row.metadataRevision.toString(),
      trashedAt: row.trashedAt?.toISOString() ?? null, restoreUntil: row.restoreUntil?.toISOString() ?? null,
      trashRequestId, checkedAtMs: clocks[0]!.now.getTime() };
}

function parseFinalization(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Invalid retention finalization');
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).sort().join() !== 'conversationId,ownerActorId,requestId,restoreUntilMs,revision,tenantId' ||
      !validId(input.tenantId) || !validId(input.conversationId) || !validId(input.ownerActorId) || !validId(input.requestId) ||
      typeof input.revision !== 'string' || !/^[1-9][0-9]{0,17}$/.test(input.revision) ||
      !Number.isSafeInteger(input.restoreUntilMs) || (input.restoreUntilMs as number) < TRASH_MS)
    throw new BadRequestException('Invalid retention finalization');
  return { tenantId: input.tenantId, conversationId: input.conversationId, ownerActorId: input.ownerActorId,
    requestId: input.requestId, revision: input.revision, restoreUntilMs: input.restoreUntilMs as number };
}

async function verifyConsumedFinalization(tx: Prisma.TransactionClient, input: ReturnType<typeof parseFinalization>) {
  const { tenantId, conversationId, ownerActorId, requestId, revision } = input;
  const requestSha256 = managementDigest({ version: MANAGEMENT_VERSION, operation: 'trash',
    requestId, conversationId, expectedRevision: (BigInt(revision) - 1n).toString() });
  const consumed = await tx.clioConversationManagementReceipt.findUnique({ where: {
    tenantId_actorUserId_requestId: { tenantId, actorUserId: ownerActorId, requestId } } });
  if (!consumed || consumed.conversationId !== null || consumed.requestSha256 !== requestSha256 ||
      !consumedDeletionMatches(consumed, { conversationId, revision,
        restoreUntil: new Date(input.restoreUntilMs as number).toISOString() })) throw unavailable();
}

/** Startup/recovery checks the current Core store, never a cached success.
 * This port reads only: an old completion whose rows reappear is unresolved.
 */
export async function verifyConversationRetention(prisma: PrismaService, raw: unknown) {
  const input = parseFinalization(raw), { tenantId, conversationId, requestId, revision } = input;
  return prisma.withSystem(async tx => {
    const exists = await tx.clioConversation.findFirst({ where: { tenantId, id: conversationId }, select: { id: true } });
    if (exists) return { version: 'meri.conversation-retention.v1' as const, tenantId, conversationId, requestId, revision, erased: false };
    await verifyConsumedFinalization(tx, input);
    const candidates = await conversationMemoryCandidatesInTx(tx, tenantId, conversationId);
    const drafts = await hasConversationOfficeDraftsInTx(tx, tenantId, conversationId);
    return { version: 'meri.conversation-retention.v1' as const, tenantId, conversationId, requestId, revision,
      erased: !drafts && !candidates.some(row => row.selected) };
  });
}

/** Called by the existing trusted purger after its version/row absence checks.
 * Rechecks Core's exact Trash generation and clock under the row lock, then
 * disposes copied proposals and metadata atomically, retaining consumed keys.
 */
export async function finalizeConversationRetention(prisma: PrismaService, raw: unknown) {
  const input = parseFinalization(raw);
  const tenantId = input.tenantId, conversationId = input.conversationId, ownerActorId = input.ownerActorId;
  const requestId = input.requestId, revision = input.revision;
  return prisma.withSystem(async tx => {
    // Match the existing memory purger's lock order before the conversation
    // row. System scope can see suppressed/held copies; every query is tenant-bound.
    await lockMemoryRetentionInTx(tx);
    await tx.$executeRaw`SELECT id FROM clio_conversations WHERE tenant_id=${tenantId}::uuid
      AND id=${conversationId}::uuid FOR UPDATE`;
    const exists = await tx.clioConversation.findFirst({ where: { tenantId, id: conversationId }, select: { id: true } });
    if (!exists) {
      await verifyConsumedFinalization(tx, input);
      // Repair restored copied proposals or orphaned Office rows. A consumed
      // tombstone alone is not proof of the current store's erasure.
      await purgeConversationMemoryInTx(tx, tenantId, conversationId);
      await eraseConversationOfficeDraftsInTx(tx, tenantId, conversationId);
      return { version: 'meri.conversation-retention.v1' as const, tenantId, conversationId, requestId, revision, erased: true, replayed: true };
    }
    const current = await retentionState(tx, { tenantId, conversationId });
    if (current.identity.ownerActorId !== ownerActorId || current.status !== 'trashed' ||
        current.trashRequestId !== requestId || current.revision !== revision ||
        current.restoreUntil === null || Date.parse(current.restoreUntil) !== input.restoreUntilMs ||
        current.checkedAtMs < (input.restoreUntilMs as number)) throw new ConflictException('RETENTION_GENERATION_NOT_EXPIRED');
    await purgeConversationMemoryInTx(tx, tenantId, conversationId);
    // The Office FK cascades within this same transaction. No separate writer
    // fence is needed: Office Open/Save lock and recheck the active chat.
    const deleted = await tx.clioConversation.deleteMany({ where: { tenantId, id: conversationId,
      userId: ownerActorId, status: 'trashed', metadataRevision: BigInt(revision), restoreUntil: new Date(input.restoreUntilMs as number) } });
    if (deleted.count !== 1) throw new ConflictException('RETENTION_GENERATION_CHANGED');
    return { version: 'meri.conversation-retention.v1' as const, tenantId, conversationId, requestId, revision, erased: true, replayed: false };
  });
}
