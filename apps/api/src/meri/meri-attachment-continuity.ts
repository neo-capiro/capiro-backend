import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { attachmentRefsFromMetadata, formatAttachmentContext, formatAttachmentFilingReference, MAX_ATTACHMENTS_PER_MESSAGE } from './meri-attachment.helpers.js';

/** A file may be reused inside its original chat, but an ID from another chat
 * must never silently move the source binding. */
export async function assertAttachmentConversation(tx: Prisma.TransactionClient, ctx: TenantContext,
  conversationId: string, rows: Array<{ messageId?: string | null }>): Promise<void> {
  const messageIds = [...new Set(rows.flatMap(row => row.messageId ? [row.messageId] : []))];
  if (!messageIds.length) return;
  const messages = await tx.clioMessage.findMany({
    where: { id: { in: messageIds }, conversationId, tenantId: ctx.tenantId, userId: ctx.userId, role: 'user' },
    select: { id: true },
  });
  if (messages.length !== messageIds.length)
    throw new BadRequestException('An attachment belongs to another chat. Upload the file in this chat before using it.');
}

/** Attachment.messageId has no FK. Reauthorize each original user message,
 * including an earlier message when the same source is reused after compaction.
 * Never fetch original bytes just to build the provider's filing references.
 */
export async function authorizedAttachmentSources(prisma: PrismaService, ctx: TenantContext,
  conversationId: string, attachmentIds: string[], visibleUserMessageIds: string[]) {
  const rows = await prisma.withTenant(ctx.tenantId, tx => tx.clioAttachment.findMany({
    where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
    select: { id: true, filename: true, kind: true, textContent: true, status: true, reason: true, messageId: true },
  }));
  const authorized = new Set(visibleUserMessageIds);
  const earlierIds = [...new Set(rows.flatMap(row => row.messageId && !authorized.has(row.messageId) ? [row.messageId] : []))];
  if (earlierIds.length) {
    const messages = await prisma.withTenant(ctx.tenantId, tx => tx.clioMessage.findMany({
      where: { id: { in: earlierIds }, conversationId, tenantId: ctx.tenantId, userId: ctx.userId, role: 'user' },
      select: { id: true },
    }));
    for (const message of messages) authorized.add(message.id);
  }
  return rows.filter(row => row.messageId != null && authorized.has(row.messageId));
}

/** Compaction summarizes prose; it must not erase the actual source text.
 * Reauthorize bounded recent document refs from older user messages. */
export async function compactedAttachmentContext(prisma: PrismaService, ctx: TenantContext,
  conversationId: string, visibleMessageIds: string[]): Promise<string> {
  const messages = await prisma.withTenant(ctx.tenantId, tx => tx.clioMessage.findMany({
    where: { conversationId, tenantId: ctx.tenantId, userId: ctx.userId, role: 'user',
      id: { notIn: visibleMessageIds }, metadata: { path: ['attachments'], not: Prisma.AnyNull } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: MAX_ATTACHMENTS_PER_MESSAGE + 1,
    select: { id: true, metadata: true },
  }));
  const refs = messages.flatMap(message => attachmentRefsFromMetadata(message.metadata));
  const ids = [...new Set(refs.map(ref => ref.id))];
  if (!ids.length) return '';
  const selected = ids.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const rows = await authorizedAttachmentSources(prisma, ctx, conversationId, selected, messages.map(message => message.id));
  return [
    'Documents uploaded earlier in this chat (retained after chat summary):',
    ...rows.map(row => row.kind !== 'image' && row.textContent != null
      ? formatAttachmentContext(row.filename, row.textContent, 12_000, row)
      : formatAttachmentFilingReference(row)),
    ...(rows.length < selected.length ? ['Some earlier attachments are unavailable. Ask for the affected file again; do not invent its content.'] : []),
    ...(ids.length > selected.length || messages.length > MAX_ATTACHMENTS_PER_MESSAGE
      ? ['Only the most recent attachments are included. Earlier files may need to be uploaded again.'] : []),
  ].join('\n\n');
}
