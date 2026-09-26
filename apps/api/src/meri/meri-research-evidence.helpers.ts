import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';
import type { MeriResearchHandoff } from './meri-research-handoff.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseEvidenceInput(input: Record<string, unknown>) {
  if (typeof input.sessionId !== 'string' || !UUID.test(input.sessionId)) {
    throw new BadRequestException('sessionId must be a research session UUID');
  }
  if (input.clientId !== undefined && (typeof input.clientId !== 'string' || !UUID.test(input.clientId))) {
    throw new BadRequestException('clientId must be a client UUID');
  }
  const limit = input.limit ?? 5;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new BadRequestException('limit must be an integer between 1 and 10');
  }
  let attachmentIds: string[] | undefined;
  if (input.attachmentIds !== undefined) {
    if (!Array.isArray(input.attachmentIds) || !input.attachmentIds.length || input.attachmentIds.length > 10 ||
        input.attachmentIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      throw new BadRequestException('attachmentIds must contain 1 to 10 attachment UUIDs');
    }
    attachmentIds = [...new Set(input.attachmentIds as string[])].sort();
  }
  let afterId: string | undefined;
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[\w-]+$/.test(input.cursor)) throw new Error();
      const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
      if (cursor.v !== 1 || cursor.sessionId !== input.sessionId || !UUID.test(cursor.afterId) ||
          JSON.stringify(cursor.attachmentIds) !== JSON.stringify(attachmentIds ?? null)) throw new Error();
      afterId = cursor.afterId;
    } catch {
      throw new BadRequestException('Invalid research evidence cursor for this session and attachment selection');
    }
  }
  return { sessionId: input.sessionId, clientId: input.clientId as string | undefined, limit, attachmentIds, afterId };
}

/** Read immutable, server-captured attachment evidence through a callable tool
 * so normal tool-result ledgers can ground its original attachment IDs. */
export async function getResearchEvidence(
  ctx: TenantContext,
  rawInput: Record<string, unknown>,
  prisma: Pick<PrismaService, 'withTenantUser'>,
) {
  const input = parseEvidenceInput(rawInput);
  return prisma.withTenantUser(ctx.tenantId, ctx.userId, async (tx) => {
    const session = await tx.clioResearchSession.findFirst({
      where: { id: input.sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      select: { id: true, clientId: true, metadata: true },
    });
    if (!session) throw new NotFoundException('Research session not found');
    if (input.clientId !== undefined && input.clientId !== session.clientId) {
      throw new NotFoundException('Research session not found in this client scope');
    }
    if (session.clientId && !(await clientMemoryAllowed(tx, ctx.tenantId, ctx.userId, session.clientId))) {
      throw new NotFoundException('Research session not found');
    }
    const metadata = session.metadata && typeof session.metadata === 'object' && !Array.isArray(session.metadata)
      ? session.metadata as Record<string, unknown> : {};
    const handoff = metadata.handoff as MeriResearchHandoff | undefined;
    if (!handoff || handoff.version !== 1 || !Array.isArray(handoff.attachments)) {
      return { tool: 'get_research_evidence', sessionId: session.id,
        coverage: { status: 'unavailable', total: null, returned: 0, truncated: null,
          complete: false, nextCursor: null, reason: 'research_handoff_unavailable' }, records: [] };
    }
    if (handoff.clientId !== session.clientId) throw new NotFoundException('Research evidence scope changed');
    if (handoff.conversationId) {
      const conversation = await tx.clioConversation.findFirst({
        where: { id: handoff.conversationId, tenantId: ctx.tenantId, userId: ctx.userId,
          clientId: session.clientId, archivedAt: null }, select: { id: true },
      });
      if (!conversation) throw new NotFoundException('Originating research conversation not found');
    }
    const availableIds = new Set(handoff.attachments.map((attachment) => attachment.id));
    if (input.attachmentIds?.some((id) => !availableIds.has(id))) {
      throw new NotFoundException('Attachment not found in this research snapshot');
    }
    const selected = handoff.attachments
      .filter((attachment) => !input.attachmentIds || input.attachmentIds.includes(attachment.id))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const remaining = input.afterId ? selected.filter((attachment) => attachment.id > input.afterId!) : selected;
    const page = remaining.slice(0, input.limit);
    const live = page.length ? await tx.clioAttachment.findMany({
      where: { id: { in: page.map((attachment) => attachment.id) }, tenantId: ctx.tenantId, userId: ctx.userId },
      select: { id: true, messageId: true, kind: true, status: true, mediaType: true, data: true },
    }) : [];
    if (live.length !== page.length) throw new NotFoundException('Research evidence is no longer available');
    const messageIds = live.flatMap((attachment) => attachment.messageId ? [attachment.messageId] : []);
    if (messageIds.length && !handoff.conversationId) {
      throw new NotFoundException('Research evidence no longer belongs to this conversation');
    }
    const messages = messageIds.length ? await tx.clioMessage.findMany({
      where: { id: { in: messageIds }, tenantId: ctx.tenantId, userId: ctx.userId,
        clientId: session.clientId, conversationId: handoff.conversationId! },
      select: { id: true },
    }) : [];
    if (new Set(messages.map((message) => message.id)).size !== new Set(messageIds).size) {
      throw new NotFoundException('Research evidence no longer belongs to this conversation');
    }
    for (const attachment of page) {
      const current = live.find((row) => row.id === attachment.id)!;
      if (attachment.sourceMessageId && current.messageId !== attachment.sourceMessageId) {
        throw new NotFoundException('Research evidence no longer belongs to its source message');
      }
      if (attachment.kind === 'image' && attachment.status === 'image_ready' && (current.kind !== 'image' || current.status !== 'image_ready' ||
          !current.data || current.mediaType !== attachment.mediaType ||
          createHash('sha256').update(Buffer.from(current.data)).digest('hex') !== attachment.contentSha256)) {
        throw new NotFoundException('Research image is unavailable or changed since the snapshot');
      }
    }
    const hasMore = remaining.length > page.length;
    const contentComplete = selected.every((attachment) => attachment.status === 'parsed' || attachment.status === 'image_ready');
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, sessionId: session.id,
      attachmentIds: input.attachmentIds ?? null, afterId: page[page.length - 1]!.id })).toString('base64url') : null;
    return {
      tool: 'get_research_evidence', sessionId: session.id, capturedAt: handoff.capturedAt,
      // These fields must precede large text so the model retains pagination
      // and incompleteness information through the shared prompt budget cap.
      coverage: { status: hasMore || !contentComplete ? 'partial' : 'complete', total: selected.length,
        returned: page.length, truncated: hasMore, paginationComplete: !hasMore,
        contentComplete, complete: !hasMore && contentComplete, nextCursor,
        note: 'Text is the immutable research snapshot. Truncated, scanned or unsupported attachments are incomplete evidence. Image bytes are supplied separately by the research runtime.' },
      records: page.map((attachment) => ({
        domain: 'research_attachments', recordId: attachment.id,
        payload: {
          id: attachment.id, title: attachment.filename, filename: attachment.filename,
          kind: attachment.kind, status: attachment.status, reason: attachment.reason,
          source: attachment.source, contentSha256: attachment.contentSha256,
          mediaType: attachment.mediaType, byteSize: attachment.byteSize,
          textContent: attachment.kind === 'image' ? null : attachment.textContent,
        },
        provenance: { sourceType: 'research_snapshot', sessionId: session.id,
          capturedAt: handoff.capturedAt, originalAttachmentId: attachment.id },
      })),
    };
  });
}
