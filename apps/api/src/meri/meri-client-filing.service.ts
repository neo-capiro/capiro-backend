import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { ClientDocumentWriterService } from '../client-documents/client-document-writer.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fetchDeniedClientIds } from '../memory/memory-wall.helpers.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import { nativeCanonicalSha256, type NativeObjectReference } from './native-approvals/native-approval.contract.js';
import type { NativeClientDocumentWrite } from '../engagement/engagement.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type FileReceipt = {
  attachmentId: string;
  fileName: string | null;
  status: 'saved' | 'pending' | 'failed';
  documentId?: string;
  location?: string;
  reason?: string;
  indexingStatus?: 'pending' | 'indexed' | 'not_indexed';
  reused?: boolean;
};

export type NativeFileObservation = Omit<FileReceipt, 'attachmentId'> & { object: NativeObjectReference };
export type NativeFilingSource = { object: NativeObjectReference; buffer: Buffer; fileName: string; contentType: string };
const nativeSource = 'meri_native_artifact';
const unavailable = () => new NotFoundException('Approved file is not currently available');

function nativeObservation(object: NativeObjectReference, clientId: string, document: {
  id: string; fileName: string; lifecycleStatus?: string; indexedAt?: Date | null; reused?: boolean;
}): NativeFileObservation {
  const status = document.lifecycleStatus === 'quarantined' ? 'pending'
    : ['ready', 'legacy_ready'].includes(document.lifecycleStatus ?? '') ? 'saved' : 'failed';
  return { object, fileName: document.fileName, status, documentId: document.id,
    location: `/clients?clientId=${clientId}&tab=files&attachmentId=${encodeURIComponent(document.id)}`,
    indexingStatus: status === 'saved' ? document.indexedAt ? 'indexed' : 'pending' : 'not_indexed',
    reused: document.reused === true,
    ...(status === 'pending' ? { reason: 'The original file is stored; document scanning is still pending.' }
      : status === 'failed' ? { reason: 'The file was stored but is unavailable under the document readiness policy.' } : {}) };
}

/** Chat filing is an adapter into the existing client Documents lifecycle. */
@Injectable()
export class MeriClientFilingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: ClientDocumentWriterService,
  ) {}

  /** Native custody uses genuine owned staged bytes, without inventing a user message. */
  async nativeSources(ctx: TenantContext, mappings: { attachmentId: string; object: NativeObjectReference }[]): Promise<NativeFilingSource[]> {
    return this.prisma.withTenant(ctx.tenantId, async tx => {
      const rows = await tx.clioAttachment.findMany({ where: { tenantId: ctx.tenantId, userId: ctx.userId,
        messageId: null, id: { in: mappings.map(value => value.attachmentId) } } });
      return mappings.map(({ attachmentId, object }) => {
        const row = rows.find(value => value.id === attachmentId);
        if (!row?.data || !row.mediaType) throw unavailable();
        const buffer = Buffer.from(row.data);
        if (buffer.length > 10 * 1024 * 1024 || buffer.length !== object.bytes || row.byteSize !== object.bytes ||
            createHash('sha256').update(buffer).digest('hex') !== object.sha256) throw unavailable();
        return { object, buffer, fileName: row.filename, contentType: row.mediaType };
      });
    });
  }

  /** The original object/version/hash, not the transient upload ID, identifies the document. */
  async saveNativeSource(ctx: TenantContext, clientId: string, source: NativeFilingSource,
    execution: Omit<NativeClientDocumentWrite, 'immutableObjectIdentity'>): Promise<NativeFileObservation> {
    const identity = nativeCanonicalSha256(source.object);
    if (source.buffer.length !== source.object.bytes || createHash('sha256').update(source.buffer).digest('hex') !== source.object.sha256) throw unavailable();
    const document = await this.documents.createAttachmentFromBuffer(ctx, {
      clientId, fileName: source.fileName, contentType: source.contentType, buffer: source.buffer,
      source: nativeSource, sourceEntityType: nativeSource, sourceEntityId: identity,
      sourceContentHash: source.object.sha256, idempotencyKey: `meri-native-artifact:${identity}`, untrustedUpload: true,
    }, { ...execution, immutableObjectIdentity: identity });
    if (!document.id) throw new ConflictException('Approved file outcome unknown');
    return nativeObservation(source.object, clientId, document);
  }

  /** Read-only proof of existing effects; absence is never evidence that S3 did not write. */
  async nativeObservations(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string,
    objects: NativeObjectReference[]): Promise<NativeFileObservation[] | null> {
    const identities = objects.map(nativeCanonicalSha256);
    await tx.$queryRaw`SELECT id::text FROM engagement_attachments
      WHERE tenant_id=${ctx.tenantId}::uuid AND client_id=${clientId}::uuid
        AND uploaded_by_user_id=${ctx.userId}::uuid AND source=${nativeSource}
        AND source_entity_type=${nativeSource} AND source_entity_id=ANY(${identities}::text[])
      ORDER BY id FOR SHARE`;
    const rows = await tx.engagementAttachment.findMany({ where: { tenantId: ctx.tenantId, clientId,
      uploadedByUserId: ctx.userId, source: nativeSource, sourceEntityType: nativeSource,
      sourceEntityId: { in: identities } }, take: objects.length + 1 });
    const observations: NativeFileObservation[] = [];
    for (const object of objects) {
      const matches = rows.filter(row => row.sourceEntityId === nativeCanonicalSha256(object));
      if (matches.length === 0) return null;
      const row = matches[0]!;
      if (matches.length !== 1 || row.sourceContentHash !== object.sha256 || row.calculatedSha256 !== object.sha256 ||
          row.byteSize !== object.bytes || row.supersededByAttachmentId || row.lifecycleStatus.startsWith('delete_')) throw unavailable();
      observations.push(nativeObservation(object, clientId, { ...row, reused: true }));
    }
    return observations;
  }

  async assertNativeOutcomeCurrent(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string,
    files: NativeFileObservation[]) {
    const current = await this.nativeObservations(tx, ctx, clientId, files.map(file => file.object));
    if (!current || current.some((file, index) => file.documentId !== files[index]!.documentId)) throw unavailable();
  }

  private async destination(ctx: TenantContext, clientId: string, conversationId?: string) {
    if (!UUID.test(clientId) || (conversationId && !UUID.test(conversationId))) {
      throw new BadRequestException('Choose a client and an existing Meri conversation.');
    }
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const denied = await fetchDeniedClientIds(tx, ctx.tenantId, ctx.userId);
      const client = await tx.client.findFirst({ where: {
        id: clientId, tenantId: ctx.tenantId, status: { not: 'archived' },
      }, select: { id: true, name: true } });
      if (!client || denied.includes(clientId)) throw new NotFoundException('Client not found');
      if (conversationId) {
        const conversation = await tx.clioConversation.findFirst({ where: {
          id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null,
        }, select: { id: true, clientId: true } });
        if (!conversation) throw new NotFoundException('Meri conversation not found');
        if (conversation.clientId && conversation.clientId !== clientId) {
          throw new BadRequestException('The selected client does not match this conversation.');
        }
      }
      return { clientId: client.id, clientName: client.name,
        location: `/clients?clientId=${client.id}&tab=files` };
    });
  }

  async saveNote(ctx: TenantContext, input: {
    clientId: string; conversationId?: string; title?: string; body: string; confidential?: boolean;
  }) {
    const body = input.body.trim();
    if (!body) throw new BadRequestException('Provide the notes to save first.');
    if (body.length > 40_000) throw new BadRequestException('Attach longer documents to save their full contents.');
    const destination = await this.destination(ctx, input.clientId, input.conversationId);
    const title = input.title?.trim() || 'Meri client note';
    const fileName = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').slice(0, 150)}.txt`;
    assertMeriToolRequestActive();
    const document = await this.documents.createAttachmentFromBuffer(ctx, {
      clientId: input.clientId, fileName, contentType: 'text/plain', buffer: Buffer.from(body, 'utf8'),
      source: 'meri_note', sourceEntityType: 'clio_conversation',
      sourceEntityId: input.conversationId ?? null,
      // The writer binds this source identity to the exact body hash. A model
      // changing only the generated title on retry must not duplicate the note.
      idempotencyKey: `meri-note:${input.conversationId ?? 'direct'}`,
      privateToUploader: input.confidential === true,
      untrustedUpload: true,
    });
    if (!document.id) throw new Error('The client document was not persisted.');
    const pending = document.lifecycleStatus === 'quarantined';
    const failed = document.lifecycleStatus != null &&
      !['ready', 'legacy_ready', 'quarantined'].includes(document.lifecycleStatus);
    return {
      tool: 'save_note', status: failed ? 'failed' : pending ? 'pending' : 'saved', generatedAt: new Date().toISOString(),
      ...destination, location: `${destination.location}&attachmentId=${encodeURIComponent(document.id)}`, documentId: document.id,
      note: { id: document.id, clientId: input.clientId, title: document.fileName.replace(/\.txt$/i, ''), body },
      indexingStatus: failed || pending || input.confidential ? 'not_indexed' : document.indexedAt ? 'indexed' : 'pending',
      ...(failed ? { message: 'The note is unavailable under the document readiness policy.' }
        : pending ? { message: 'The note is stored in the client profile Files tab; document scanning is still pending.' }
        : input.confidential ? { message: 'Private note saved in the client profile Files tab for your access. It is excluded from shared client knowledge.' } : {}),
      reused: document.reused === true,
    };
  }

  /**
   * File a server-generated job deliverable (one user confirmation) into the
   * client's Files. Same destination checks and readiness receipt as a note.
   */
  async saveJobDeliverable(ctx: TenantContext, input: {
    clientId: string; conversationId?: string; jobId: string; index: number;
    fileName: string; contentType: string; buffer: Buffer;
  }) {
    const destination = await this.destination(ctx, input.clientId, input.conversationId);
    const document = await this.documents.createAttachmentFromBuffer(ctx, {
      clientId: input.clientId, fileName: input.fileName, contentType: input.contentType,
      buffer: input.buffer, source: 'meri_job', sourceEntityType: 'clio_research_session',
      sourceEntityId: input.jobId, idempotencyKey: `meri-job:${input.jobId}:${input.index}`,
      untrustedUpload: true,
    });
    if (!document.id) throw new Error('The client document was not persisted.');
    const pending = document.lifecycleStatus === 'quarantined';
    const failed = document.lifecycleStatus != null &&
      !['ready', 'legacy_ready', 'quarantined'].includes(document.lifecycleStatus);
    return {
      status: failed ? 'failed' as const : pending ? 'pending' as const : 'saved' as const,
      ...destination,
      location: `${destination.location}&attachmentId=${encodeURIComponent(document.id)}`,
      documentId: document.id, fileName: document.fileName, reused: document.reused === true,
      ...(failed ? { message: 'The document was stored but is unavailable under the document readiness policy.' }
        : pending ? { message: 'The document is stored in the client profile Files tab; scanning is still pending.' }
        : {}),
    };
  }

  async saveAttachments(ctx: TenantContext, input: {
    clientId: string; conversationId: string; attachmentIds: unknown;
  }) {
    if (!Array.isArray(input.attachmentIds) || input.attachmentIds.length < 1 ||
        input.attachmentIds.length > 10 ||
        input.attachmentIds.some((id) => typeof id !== 'string' || !UUID.test(id))) {
      throw new BadRequestException('Choose between 1 and 10 chat attachment IDs.');
    }
    const ids = [...new Set(input.attachmentIds as string[])];
    const destination = await this.destination(ctx, input.clientId, input.conversationId);
    // Attachment.messageId has no FK (edit/resend removes old messages). Check
    // the live user message as well as the attachment owner; guessed IDs, an
    // upload that was never sent, and an orphan after edit are not authority.
    const attachments = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const messages = await tx.clioMessage.findMany({ where: {
        conversationId: input.conversationId, tenantId: ctx.tenantId,
        userId: ctx.userId, role: 'user',
      }, select: { id: true } });
      return tx.clioAttachment.findMany({ where: {
        id: { in: ids }, tenantId: ctx.tenantId, userId: ctx.userId,
        messageId: { in: messages.map((message) => message.id) },
      } });
    });
    const files: FileReceipt[] = [];
    for (const attachmentId of ids) {
      const row = attachments.find((attachment) => attachment.id === attachmentId);
      if (!row) {
        files.push({ attachmentId, fileName: null, status: 'failed',
          reason: 'This attachment is not available in your current conversation.' });
        continue;
      }
      if (!row.data?.byteLength || !row.mediaType) {
        files.push({ attachmentId, fileName: row.filename, status: 'failed',
          reason: 'The original file is unavailable. Reattach the file to save it under this client.' });
        continue;
      }
      try {
        assertMeriToolRequestActive();
        const document = await this.documents.createAttachmentFromBuffer(ctx, {
          clientId: input.clientId, fileName: row.filename, contentType: row.mediaType,
          buffer: Buffer.from(row.data), source: 'meri_chat_attachment',
          sourceEntityType: 'clio_attachment', sourceEntityId: row.id,
          idempotencyKey: `meri-chat-attachment:${row.id}`, untrustedUpload: true,
        });
        if (!document.id) throw new Error('The client document was not persisted.');
        const pending = document.lifecycleStatus === 'quarantined';
        const failed = document.lifecycleStatus != null &&
          !['ready', 'legacy_ready', 'quarantined'].includes(document.lifecycleStatus);
        files.push({ attachmentId, fileName: row.filename,
          status: failed ? 'failed' : pending ? 'pending' : 'saved',
          documentId: document.id, location: `${destination.location}&attachmentId=${encodeURIComponent(document.id)}`,
          indexingStatus: failed || pending ? 'not_indexed' : document.indexedAt ? 'indexed' : 'pending', reused: document.reused === true,
          ...(failed ? { reason: 'The file was stored but is unavailable under the document readiness policy.' }
            : pending ? { reason: 'The original file is stored; document scanning is still pending.' }
            : row.status === 'truncated' ? { reason: row.reason || 'Original saved; chat text extraction was partial.' }
            : {}),
        });
      } catch (error) {
        assertMeriToolRequestActive();
        // Never turn a failed S3/database write into a saved receipt, and never
        // discard the successful siblings of a partially completed batch.
        files.push({ attachmentId, fileName: row.filename, status: 'failed',
          reason: error instanceof BadRequestException ? error.message : 'The file could not be saved. Retry this file.' });
      }
    }
    const savedCount = files.filter((file) => file.status === 'saved').length;
    const pendingCount = files.filter((file) => file.status === 'pending').length;
    const failedCount = files.filter((file) => file.status === 'failed').length;
    const status = savedCount === files.length ? 'saved'
      : failedCount === files.length ? 'failed'
      : pendingCount === files.length ? 'pending' : 'partial';
    return { tool: 'save_chat_attachments', status, generatedAt: new Date().toISOString(),
      ...destination, savedCount, pendingCount, failedCount, files };
  }
}
