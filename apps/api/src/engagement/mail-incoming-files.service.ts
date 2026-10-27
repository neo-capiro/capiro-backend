import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { EngagementService, isAllowedAttachmentContentType } from './engagement.service.js';
import { ownMailMessageWhere, ownMailThreadWhere, requireMailReadScope } from './engagement-access.helpers.js';
import { GmailSendService } from './google/gmail-send.service.js';
import { MicrosoftGraphSyncService } from './microsoft/microsoft-graph-sync.service.js';
import { storedGraphReplyIdentity } from './single-mail-reply.js';
import { IncomingFilesHandoff, incomingHash, incomingObject, type IncomingImportSelection, type IncomingProviderSource } from './mail-incoming-files.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
export interface IncomingMailSelection { threadId: string; messageId: string; updatedAt: string; clientId?: string }
export function incomingMailSelection(value: unknown): IncomingMailSelection {
  const row = incomingObject(value);
  if (Object.keys(row).some(key => !['threadId', 'messageId', 'updatedAt', 'clientId'].includes(key)) ||
      typeof row.threadId !== 'string' || !UUID.test(row.threadId) || typeof row.messageId !== 'string' || !UUID.test(row.messageId) ||
      (row.clientId !== undefined && (typeof row.clientId !== 'string' || !UUID.test(row.clientId))) ||
      typeof row.updatedAt !== 'string' || row.updatedAt.length > 30 || !Number.isFinite(Date.parse(row.updatedAt)) ||
      new Date(row.updatedAt).toISOString() !== row.updatedAt) throw new BadRequestException('Select an exact current mail message.');
  return row as unknown as IncomingMailSelection;
}
const unavailable = () => new NotFoundException('Mail message not found');

/** Existing current mail predicates apply to the same exact original at every boundary. */
export async function incomingMailSource(tx: Prisma.TransactionClient, ctx: TenantContext, selected: IncomingMailSelection, lock = false) {
  if (lock) {
    // Ordinary updates/deletes conflict with these row locks. No provider/storage I/O holds them.
    await tx.$executeRaw(Prisma.sql`SELECT id FROM mail_threads WHERE tenant_id=${ctx.tenantId}::uuid AND id=${selected.threadId}::uuid FOR SHARE`);
    await tx.$executeRaw(Prisma.sql`SELECT id FROM mail_messages WHERE tenant_id=${ctx.tenantId}::uuid AND id=${selected.messageId}::uuid FOR SHARE`);
  }
  await requireMailReadScope(tx, ctx, selected.clientId);
  const thread = await tx.mailThread.findFirst({ where: { id: selected.threadId, tenantId: ctx.tenantId,
    ...(selected.clientId ? { clientId: selected.clientId } : {}), ...ownMailThreadWhere(ctx.userId) },
    select: { id: true, clientId: true, connectionId: true, source: true, externalId: true } });
  if (!thread?.connectionId) throw unavailable();
  if (thread.clientId && thread.clientId !== selected.clientId) await requireMailReadScope(tx, ctx, thread.clientId);
  if (lock) await tx.$executeRaw(Prisma.sql`SELECT id FROM integration_connections WHERE tenant_id=${ctx.tenantId}::uuid AND id=${thread.connectionId}::uuid FOR SHARE`);
  const connection = await tx.integrationConnection.findFirst({ where: { id: thread.connectionId, tenantId: ctx.tenantId,
    createdByUserId: ctx.userId, status: 'connected' }, select: { id: true, provider: true, accountEmail: true } });
  const message = await tx.mailMessage.findFirst({ where: { id: selected.messageId, tenantId: ctx.tenantId,
    threadId: thread.id, connectionId: thread.connectionId, ...ownMailMessageWhere(ctx.userId) },
    select: { id: true, updatedAt: true, externalId: true, source: true, raw: true } });
  if (!connection || !message) throw unavailable();
  if (message.updatedAt.toISOString() !== selected.updatedAt) throw new ConflictException('The selected message changed. Refresh it before importing files.');
  const raw = incomingObject(message.raw);
  let provider: IncomingProviderSource;
  if (connection.provider === 'google_workspace' && message.source === 'google' && thread.source === 'google' &&
      typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,2048}$/.test(raw.id) && raw.id === message.externalId &&
      typeof raw.threadId === 'string' && raw.threadId === thread.externalId && typeof raw.historyId === 'string' && /^\d{1,40}$/.test(raw.historyId)) {
    provider = { provider: 'gmail', messageId: raw.id, threadId: raw.threadId, version: raw.historyId };
  } else {
    const capture = incomingObject(raw.graphReplySource), identity = storedGraphReplyIdentity(capture.identity);
    if (connection.provider !== 'microsoft_365' || message.source !== 'outlook' || thread.source !== 'outlook' ||
        capture.schema !== 'graph-native-reply/1' || capture.defaultId !== message.externalId ||
        !identity || identity.conversationId !== thread.externalId)
      throw new IncomingFilesHandoff('original_provider_identity_unavailable');
    provider = { provider: 'microsoft_graph', messageId: identity.immutableId, threadId: identity.conversationId, version: identity.changeKey };
  }
  return { provider, connectionId: connection.id, accountEmail: connection.accountEmail, clientId: thread.clientId };
}

@Injectable()
export class MailIncomingFilesService {
  constructor(private readonly prisma: PrismaService, private readonly attachments: EngagementService,
    private readonly gmail: GmailSendService, private readonly graph: MicrosoftGraphSyncService,
    private readonly runtime: EngagementRuntimePolicyService) {}

  async read(ctx: TenantContext, input: unknown, importInput?: unknown) {
    const selected = incomingMailSelection(input);
    let selection: IncomingImportSelection | undefined;
    if (importInput !== undefined) {
      const row = incomingObject(importInput);
      if (Object.keys(row).sort().join(',') !== 'fileKey,manifestSha256' || typeof row.fileKey !== 'string' || !HASH.test(row.fileKey) || typeof row.manifestSha256 !== 'string' || !HASH.test(row.manifestSha256))
        throw new BadRequestException('Choose a file from the current message manifest.');
      selection = row as unknown as IncomingImportSelection;
      this.runtime.assertExternalAction('attachment_external_write');
    }
    this.runtime.assertExternalAction('attachment_external_read');
    try {
      const resolve = () => this.prisma.withTenant(ctx.tenantId, tx => incomingMailSource(tx, ctx, selected));
      const source = await resolve(), proof = incomingHash(source);
      const current = async (tx?: Prisma.TransactionClient) => {
        const latest = tx ? await incomingMailSource(tx, ctx, selected, true) : await resolve();
        if (incomingHash(latest) !== proof) throw new ConflictException('The selected mailbox or message changed. Refresh before importing.');
      };
      const adapter = source.provider.provider === 'gmail' ? this.gmail : this.graph;
      const result = await adapter.readIncomingFiles(ctx, source.connectionId, source.provider, selection, isAllowedAttachmentContentType);
      await current();
      const original = { threadId: selected.threadId, messageId: selected.messageId, updatedAt: selected.updatedAt,
        connectionId: source.connectionId };
      if (!selection) return { state: 'manifest' as const, original, manifestSha256: result.manifestSha256,
        files: result.files.map(file => { const reason = file.handoff ?? (isAllowedAttachmentContentType(file.contentType) ? null : 'unsupported_file_type');
          return { fileKey: file.key, name: file.name, contentType: file.contentType, bytes: file.bytes,
            status: reason ? 'mailbox_handoff' : 'importable', reason }; }),
        notice: 'Current provider file list only. Files are not downloaded or cleared for use until imported and scanned.' };
      if (!result.imported) throw new Error('Provider import did not return selected file bytes');
      const { file, buffer } = result.imported;
      const sha256 = createHash('sha256').update(buffer).digest('hex');
      const provenance = incomingHash([original, source.provider, result.manifestSha256, file.key]);
      const receipt = await this.attachments.createAttachmentFromBuffer(ctx, {
        clientId: source.clientId, mailMessageId: selected.messageId,
        fileName: file.name, contentType: file.contentType, buffer,
        source: 'incoming_mail', sourceEntityType: 'incoming_mail_file',
        sourceEntityId: `${selected.messageId}:${provenance}`, sourceVersion: 1, sourceContentHash: sha256,
        idempotencyKey: `incoming-mail:${provenance}`, untrustedUpload: true, privateToUploader: true,
      }, undefined, { beforeWrite: current });
      await current();
      return { state: 'imported' as const, original, manifestSha256: result.manifestSha256, fileKey: file.key,
        provenanceSha256: provenance, attachment: { id: receipt.id, fileName: receipt.fileName,
          contentType: file.contentType, bytes: buffer.length, sha256,
          lifecycleStatus: receipt.lifecycleStatus, scanStatus: receipt.scanStatus ?? null }, reused: receipt.reused === true,
        notice: 'Stored private file receipt. Existing attachment access and scan readiness still control download and reuse; no mail was sent.' };
    } catch (error) {
      if (error instanceof IncomingFilesHandoff) return { state: 'mailbox_handoff' as const, reason: error.reason,
        original: selected, notice: 'Open the original message in your mailbox for this file. No usable imported-file receipt is available.' };
      throw error;
    }
  }
}
