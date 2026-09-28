import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  attachmentRefsFromMetadata,
  formatAttachmentContext,
  formatAttachmentFilingReference,
  MAX_ATTACHMENTS_PER_MESSAGE,
} from './meri-attachment.helpers.js';
import {
  describeAttachmentContentState,
  type AttachmentContentState,
} from './meri-attachment-content-state.js';
import { sha256Bytes } from './meri-artifact-integrity.js';

export const PRIOR_ATTACHMENT_MANIFEST_LIMIT = 20;

export interface PriorAttachmentManifestItem {
  id: string;
  filename: string;
  turn: number;
  uploadedAt: Date;
  state: AttachmentContentState;
  extractedChars: number;
}

const XLSX_SOURCE_HASH_PREFIX = 'Source SHA-256: ';

function cachedXlsxTextMatchesBytes(
  text: string | null,
  data: Uint8Array | null | undefined,
): boolean {
  if (!text || !data) return false;
  const lineEnd = text.indexOf('\n');
  const firstLine = lineEnd < 0 ? text : text.slice(0, lineEnd);
  if (!firstLine.startsWith(XLSX_SOURCE_HASH_PREFIX)) return false;
  const sourceHash = firstLine.slice(XLSX_SOURCE_HASH_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(sourceHash) && sourceHash === sha256Bytes(data);
}

/** A file may be reused inside its original chat, but an ID from another chat
 * must never silently move the source binding. */
export async function assertAttachmentConversation(
  tx: Prisma.TransactionClient,
  ctx: TenantContext,
  conversationId: string,
  rows: Array<{ messageId?: string | null }>,
): Promise<void> {
  const messageIds = [...new Set(rows.flatMap((row) => (row.messageId ? [row.messageId] : [])))];
  if (!messageIds.length) return;
  const messages = await tx.clioMessage.findMany({
    where: {
      id: { in: messageIds },
      conversationId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      role: 'user',
    },
    select: { id: true },
  });
  if (messages.length !== messageIds.length)
    throw new BadRequestException(
      'An attachment belongs to another chat. Upload the file in this chat before using it.',
    );
}

/** Attachment.messageId has no FK. Reauthorize each original user message,
 * including an earlier message when the same source is reused after compaction.
 * XLSX bytes are read narrowly to verify cached text against the currently
 * saved source; a missing or changed source fails closed instead of replaying.
 */
export async function authorizedAttachmentSources(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
  attachmentIds: string[],
  visibleUserMessageIds: string[],
  includeData = false,
) {
  const rows = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioAttachment.findMany({
      where: { id: { in: attachmentIds }, tenantId: ctx.tenantId, userId: ctx.userId },
      select: {
        id: true,
        filename: true,
        kind: true,
        textContent: true,
        status: true,
        reason: true,
        messageId: true,
        pages: true,
        ...(includeData ? { data: true } : {}),
      },
    }),
  );
  const xlsxIds = rows.filter((row) => row.kind === 'xlsx').map((row) => row.id);
  const xlsxData = new Map<string, Uint8Array | null>();
  if (includeData) {
    for (const row of rows as Array<(typeof rows)[number] & { data?: Uint8Array | null }>) {
      if (row.kind === 'xlsx') xlsxData.set(row.id, row.data ?? null);
    }
  } else if (xlsxIds.length) {
    const savedSources = await prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioAttachment.findMany({
        where: { id: { in: xlsxIds }, tenantId: ctx.tenantId, userId: ctx.userId, kind: 'xlsx' },
        select: { id: true, data: true },
      }),
    );
    for (const source of savedSources) xlsxData.set(source.id, source.data);
  }
  const authorized = new Set(visibleUserMessageIds);
  const earlierIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.messageId && !authorized.has(row.messageId) ? [row.messageId] : [],
      ),
    ),
  ];
  if (earlierIds.length) {
    const messages = await prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioMessage.findMany({
        where: {
          id: { in: earlierIds },
          conversationId,
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          role: 'user',
        },
        select: { id: true },
      }),
    );
    for (const message of messages) authorized.add(message.id);
  }
  return rows.filter(
    (row) =>
      row.messageId != null &&
      authorized.has(row.messageId) &&
      (row.kind !== 'xlsx' || cachedXlsxTextMatchesBytes(row.textContent, xlsxData.get(row.id))),
  );
}

/** A metadata-only inventory for resumable runtimes. It never replays attachment text or bytes. */
export async function previousAttachmentManifest(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
  currentMessageId: string | null,
): Promise<PriorAttachmentManifestItem[]> {
  const messages = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioMessage.findMany({
      where: {
        conversationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: 'user',
        ...(currentMessageId ? { id: { not: currentMessageId } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, createdAt: true },
    }),
  );
  if (!messages.length) return [];
  const messageIds = messages.map((message) => message.id);
  const rows = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioAttachment.findMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId, messageId: { in: messageIds } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: PRIOR_ATTACHMENT_MANIFEST_LIMIT,
      select: {
        id: true,
        filename: true,
        status: true,
        textContent: true,
        reason: true,
        kind: true,
        pages: true,
        createdAt: true,
        messageId: true,
      },
    }),
  );
  const turnByMessage = new Map(
    [...messages].reverse().map((message, index) => [message.id, index + 1]),
  );
  return rows.map((row) => {
    const content = describeAttachmentContentState(row);
    return {
      id: row.id,
      filename: row.filename,
      turn: turnByMessage.get(row.messageId!) ?? 0,
      uploadedAt: row.createdAt,
      state: content.state,
      extractedChars: content.extractedChars,
    };
  });
}

/** Compaction summarizes prose; it must not erase the actual source text.
 * Reauthorize bounded recent document refs from older user messages. */
export async function compactedAttachmentContext(
  prisma: PrismaService,
  ctx: TenantContext,
  conversationId: string,
  visibleMessageIds: string[],
): Promise<string> {
  const messages = await prisma.withTenant(ctx.tenantId, (tx) =>
    tx.clioMessage.findMany({
      where: {
        conversationId,
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        role: 'user',
        id: { notIn: visibleMessageIds },
        metadata: { path: ['attachments'], not: Prisma.AnyNull },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_ATTACHMENTS_PER_MESSAGE + 1,
      select: { id: true, metadata: true },
    }),
  );
  const refs = messages.flatMap((message) => attachmentRefsFromMetadata(message.metadata));
  const ids = [...new Set(refs.map((ref) => ref.id))];
  if (!ids.length) return '';
  const selected = ids.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  const rows = await authorizedAttachmentSources(
    prisma,
    ctx,
    conversationId,
    selected,
    messages.map((message) => message.id),
  );
  return [
    'Documents uploaded earlier in this chat (retained after chat summary):',
    ...rows.map((row) =>
      row.kind !== 'image' && row.textContent != null
        ? formatAttachmentContext(row.filename, row.textContent, 12_000, row)
        : formatAttachmentFilingReference(row),
    ),
    ...(rows.length < selected.length
      ? [
          'Some earlier attachments are unavailable. Ask for the affected file again; do not invent its content.',
        ]
      : []),
    ...(ids.length > selected.length || messages.length > MAX_ATTACHMENTS_PER_MESSAGE
      ? [
          'Only the most recent attachments are included. Earlier files may need to be uploaded again.',
        ]
      : []),
  ].join('\n\n');
}
