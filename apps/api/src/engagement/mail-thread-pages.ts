import { FORWARD_UNAVAILABLE } from './mail-forward-source.js';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { ownMailThreadWhere, requireMailReadScope } from './engagement-access.helpers.js';
import { activeMailMessageWhere } from './mail-message-state.js';
import { getMailSyncCoverage } from './mail-sync-coverage.js';
import { createMailBodySection } from './mail-body-section.js';
import { normalizeMailReadRecipients, mailReadClientAssociation, activeMailAssociationMessage } from './mail-query.js';
import { prepareMailReply, prepareMailReplyAll, prepareMailForward, REPLY_UNAVAILABLE, type MailReplyContext } from './single-mail-reply.js';
import { replySelfEmails } from './single-mail-authority.js';
export { requireMailReadScope } from './engagement-access.helpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new NotFoundException('Mail thread not found');
const invalid = () => new BadRequestException('Use a bounded mail page and its exact continuation.');
const changed = () => new ConflictException('This stored thread changed. Refresh before continuing.');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface MailThreadPageInput {
  limit?: unknown;
  messageOffset?: unknown;
  messageId?: unknown;
  asOf?: unknown;
  cursor?: unknown;
  /** Existing source-viewer cursor validation, not a new revision or authority token. */
  expectedUpdatedAt?: unknown;
  /** Source viewer must still prove its original cited message is active. */
  requiredMessageId?: string;
  bodyOffset?: unknown;
  maxCharacters?: unknown;
  expectedBodySha256?: unknown;
}
export interface MailThreadHttpPageInput extends MailThreadPageInput {
  associationClientId?: unknown;
  recipientEmails?: unknown;
}
type ProfileEmails = (tx: Prisma.TransactionClient, clientId: string) => Promise<string[]>;
interface ContactAssociation { clientId: string; recipients: string[]; profileEmails: ProfileEmails }

function integer(value: unknown, fallback: number, min: number, max: number) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw invalid();
  return result;
}
function instant(value: unknown) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw invalid();
  return new Date(value).toISOString();
}
function mailboxIds(value?: readonly string[]) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 4096 ||
      value.some((id) => typeof id !== 'string' || !UUID.test(id)) ||
      new Set(value.map((id) => id.toLowerCase())).size !== value.length) throw invalid();
  return [...value].map((id) => id.toLowerCase()).sort();
}

/** Positions are scoped read hints. Every page still rechecks current Core ownership and walls. */
function threadPage(ctx: TenantContext, threadId: string, clientId: string | undefined,
  boxes: readonly string[] | undefined, input: MailThreadPageInput, association?: ContactAssociation) {
  if (!UUID.test(threadId) || (clientId && !UUID.test(clientId))) throw invalid();
  if (input.requiredMessageId && !UUID.test(input.requiredMessageId)) throw invalid();
  const messageId = input.messageId == null || input.messageId === '' ? undefined : String(input.messageId);
  if (messageId && !UUID.test(messageId)) throw invalid();
  const limit = integer(input.limit, 3, 1, 10);
  const scope = hash([ctx.tenantId, ctx.userId, threadId, clientId ?? null, boxes ?? null,
    messageId ?? null, input.requiredMessageId ?? null, limit,
    association ? [association.clientId, association.recipients] : null]);
  let offset = integer(input.messageOffset, 0, 0, 10000);
  let asOf = input.asOf == null ? new Date().toISOString() : instant(input.asOf);
  let expectedUpdatedAt = input.expectedUpdatedAt == null ? undefined : instant(input.expectedUpdatedAt);
  if (input.cursor != null) {
    if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw invalid();
    let cursor: Record<string, unknown>;
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch { throw invalid(); }
    if (!cursor || cursor.v !== 1 || cursor.scope !== scope || input.messageOffset != null ||
        Object.keys(cursor).sort().join(',') !== 'asOf,offset,scope,updatedAt,v') throw invalid();
    offset = integer(cursor.offset, 0, 1, 10000);
    const anchor = instant(cursor.asOf), version = instant(cursor.updatedAt);
    if ((input.asOf != null && asOf !== anchor) ||
        (expectedUpdatedAt && expectedUpdatedAt !== version)) throw invalid();
    asOf = anchor;
    expectedUpdatedAt = version;
  }
  if (Date.parse(asOf) > Date.now() + 1000) throw invalid();
  return { limit, offset, messageId, asOf, expectedUpdatedAt,
    cursor: (next: number, updatedAt: string) => Buffer.from(JSON.stringify({
      v: 1, scope, offset: next, asOf, updatedAt,
    })).toString('base64url') };
}

const messageSelect = {
  id: true, tenantId: true, threadId: true, connectionId: true, subject: true,
  fromEmail: true, fromName: true, toRecipients: true, ccRecipients: true,
  bodyText: true, sentAt: true, receivedAt: true, createdAt: true, updatedAt: true,
  removedAt: true, metadata: true, hasAttachments: true,
} satisfies Prisma.MailMessageSelect;
const chronologicalOrder = [
  { sentAt: 'asc' }, { receivedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' },
] satisfies Prisma.MailMessageOrderByWithRelationInput[];

/** Bounded DB message selection. Existing provider bodies/hash/UTF-16 mapping stay intact. */
export async function readMailThreadPage(prisma: PrismaService, ctx: TenantContext,
  threadId: string, clientId?: string, authorizedMailboxIds?: readonly string[], input: MailThreadPageInput = {}, association?: ContactAssociation) {
  const boxes = mailboxIds(authorizedMailboxIds), page = threadPage(ctx, threadId, clientId, boxes, input, association);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await tx.$executeRaw`SELECT set_config('statement_timeout', '10000ms', true)`;
    await requireMailReadScope(tx, ctx, clientId ?? association?.clientId);
    const thread = await tx.mailThread.findFirst({
      where: { id: threadId, tenantId: ctx.tenantId, ...(clientId ? { clientId } : {}),
        ...(boxes ? { connectionId: { in: boxes } } : {}), ...ownMailThreadWhere(ctx.userId) },
      select: {
        id: true, tenantId: true, clientId: true, connectionId: true, subject: true, source: true, externalId: true,
        snippet: true, participants: true, lastMessageAt: true, createdAt: true, updatedAt: true,
        client: { select: { id: true, name: true, website: true, primaryContactName: true,
          primaryContactEmail: true, intakeData: true } },
        connection: { select: { id: true, tenantId: true, createdByUserId: true,
          accountEmail: true, provider: true, status: true, lastSyncAt: true, syncState: true } },
      },
    });
    if (!thread || !thread.connection || thread.connection.tenantId !== ctx.tenantId ||
        thread.connection.createdByUserId !== ctx.userId) throw unavailable();
    // General and contact-associated reads must honor the thread's actual client,
    // even when the caller did not select it or selected a different client.
    if (thread.clientId && thread.clientId !== (clientId ?? association?.clientId))
      await requireMailReadScope(tx, ctx, thread.clientId);
    if (association) {
      const emails = [...new Set([...(await association.profileEmails(tx, association.clientId)), ...association.recipients])];
      const proof = await tx.$queryRaw<Array<{ allowed: boolean }>>(Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM mail_threads t WHERE t.id=${threadId}::uuid AND t.tenant_id=${ctx.tenantId}::uuid
          AND ${mailReadClientAssociation(association.clientId, emails, new Date(page.asOf))}
          ${association.recipients.length ? Prisma.sql`AND ${activeMailAssociationMessage(association.recipients, new Date(page.asOf))}` : Prisma.empty}
      ) AS allowed`);
      if (proof[0]?.allowed !== true) throw unavailable();
    }
    const updatedAt = thread.updatedAt.toISOString();
    // This is the existing change timestamp, not an immutable revision/snapshot.
    if (page.expectedUpdatedAt && page.expectedUpdatedAt !== updatedAt) throw changed();
    const activeWhere: Prisma.MailMessageWhereInput = {
      tenantId: ctx.tenantId, threadId, connectionId: thread.connectionId,
      ...activeMailMessageWhere(), createdAt: { lte: new Date(page.asOf) },
    };
    if (input.requiredMessageId && !await tx.mailMessage.findFirst({
      where: { ...activeWhere, id: input.requiredMessageId }, select: { id: true },
    })) throw unavailable();
    const where: Prisma.MailMessageWhereInput = {
      ...activeWhere,
      ...(page.messageId ? { id: page.messageId } : {}),
    };
    const totalMessages = await tx.mailMessage.count({ where });
    const rows = await tx.mailMessage.findMany({ where, orderBy: chronologicalOrder,
      select: { ...messageSelect, ...(page.messageId ? { raw: true, source: true, externalId: true } as const : {}) },
      take: page.limit, skip: page.offset });
    const messages = rows.map(message => ({ ...message, replyContext: undefined as MailReplyContext | undefined, replyAllContext: undefined as MailReplyContext | undefined, forwardContext: undefined as MailReplyContext | undefined }));
    if (page.messageId) {
      for (const message of messages) {
        message.replyContext = { supported: false, reason: REPLY_UNAVAILABLE };
        message.replyAllContext = { supported: false, reason: REPLY_UNAVAILABLE };
        message.forwardContext = { supported: false, reason: FORWARD_UNAVAILABLE };
        const source = { ...message, source: message.source ?? '', externalId: message.externalId ?? '' };
        const candidate = prepareMailReply(source, thread, thread.connection, []);
        if (candidate) {
          try {
            const selfEmails = await replySelfEmails(tx, ctx);
            const reply = prepareMailReply(source, thread, thread.connection, selfEmails);
            const replyAll = prepareMailReplyAll(source, thread, thread.connection, selfEmails);
            const forward = prepareMailForward(source, thread, thread.connection, selfEmails);
            if (forward) message.forwardContext = forward.context;
            if (replyAll) message.replyAllContext = replyAll.context;
            if (reply) message.replyContext = reply.context;
          } catch (error) {
            // Eligibility is additive to the ordinary read. Only this bounded
            // self-address refusal degrades to unsupported; DB failures propagate.
            if (!(error instanceof BadRequestException && error.message === REPLY_UNAVAILABLE)) throw error;
          }
        }
      }
    }
    const hasMore = page.offset + messages.length < totalMessages;
    const nextOffset = hasMore && messages.length && page.offset + messages.length <= 10000
      ? page.offset + messages.length : null;
    const { connection, ...rest } = thread;
    return {
      ...rest, associationClientId: association?.clientId ?? null,
      connectionEmail: connection.accountEmail, connectionStatus: connection.status,
      connectionOwnerTenantId: connection.tenantId, connectionOwnerActorId: connection.createdByUserId,
      messages, totalMessages, messageOffset: page.offset, hasMore,
      nextMessageOffset: nextOffset, nextCursor: nextOffset === null ? null : page.cursor(nextOffset, updatedAt),
      asOf: page.asOf,
      coverage: getMailSyncCoverage(connection),
      notice: 'Stored active mail only. This is a bounded current read, not a mailbox snapshot or a claim of complete provider history.',
    };
  }, { readOnly: true, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeoutMs: 12000 });
}

/** HTTP never serializes whole stored bodies; assistant mappers retain their exact selected body internally. */
export async function readMailThreadHttpPage(prisma: PrismaService, ctx: TenantContext,
  threadId: string, clientId?: string, input: MailThreadHttpPageInput = {}, profileEmails?: ProfileEmails) {
  let association: ContactAssociation | undefined;
  if (input.associationClientId !== undefined) {
    if (clientId || typeof input.associationClientId !== 'string' || !UUID.test(input.associationClientId) || !profileEmails) throw invalid();
    association = { clientId: input.associationClientId, recipients: normalizeMailReadRecipients(input.recipientEmails), profileEmails };
  } else if (input.recipientEmails !== undefined) throw invalid();
  const bodyOffset = integer(input.bodyOffset, 0, 0, 10000000);
  const maxCharacters = integer(input.maxCharacters, 6000, 1, 6000);
  if (bodyOffset > 0 && (!input.messageId || typeof input.expectedBodySha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.expectedBodySha256))) throw invalid();
  const thread = await readMailThreadPage(prisma, ctx, threadId, clientId, undefined, input, association);
  if (input.messageId && thread.messages.length !== 1) throw unavailable();
  const { client: _client, source: _source, externalId: _externalId, ...result } = thread;
  return { ...result, messages: thread.messages.map(message => {
    const body = message.bodyText ?? '';
    const bodySha256 = createHash('sha256').update(body, 'utf8').digest('hex');
    if (input.expectedBodySha256 !== undefined && input.expectedBodySha256 !== bodySha256) throw changed();
    const section = createMailBodySection(body, bodyOffset, maxCharacters);
    const { metadata, raw: _raw, source: _messageSource, externalId: _messageExternalId, ...fields } = message;
    const provenance = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {};
    return { ...fields, ...section, bodySha256,
      bodyStoredPresent: message.bodyText !== null,
      folder: typeof provenance.folder === 'string' ? provenance.folder : null,
      internetMessageId: typeof provenance.internetMessageId === 'string' ? provenance.internetMessageId : null,
      bodyCompleteness: metadata && typeof metadata === 'object' && !Array.isArray(metadata) &&
        typeof metadata.bodyCompleteness === 'string' && ['full', 'preview', 'truncated'].includes(metadata.bodyCompleteness)
        ? metadata.bodyCompleteness : 'unknown' };
  }) };
}
