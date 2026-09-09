import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriClientFilingService } from './meri-client-filing.service.js';

const CLIENT = '10000000-0000-4000-8000-000000000001';
const CONVERSATION = '20000000-0000-4000-8000-000000000002';
const FILE = '30000000-0000-4000-8000-000000000003';
const FILE2 = '30000000-0000-4000-8000-000000000004';
const ctx = { tenantId: 'tenant', userId: 'user' } as TenantContext;

function harness() {
  const row = { id: FILE, filename: 'advocacy-letter.pdf', mediaType: 'application/pdf',
    data: Buffer.from('%PDF-original'), status: 'parsed' };
  const tx = {
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    client: { findFirst: jest.fn().mockResolvedValue({ id: CLIENT, name: 'Sightline Intelligence' }) },
    clioConversation: { findFirst: jest.fn().mockResolvedValue({ id: CONVERSATION, clientId: CLIENT }) },
    clioMessage: { findMany: jest.fn().mockResolvedValue([{ id: 'message' }]) },
    clioAttachment: { findMany: jest.fn().mockResolvedValue([row]) },
  };
  const documents = { createAttachmentFromBuffer: jest.fn().mockResolvedValue({
    id: 'durable-document', fileName: row.filename, lifecycleStatus: 'ready', indexedAt: null,
  }) };
  const prisma = { withTenant: jest.fn((_tenant, fn) => fn(tx)) };
  const service = new MeriClientFilingService(prisma as never, documents as never);
  return { service, tx, documents, row };
}

describe('Meri client filing', () => {
  it('files original bytes in the canonical client store and reports indexing separately', async () => {
    const { service, tx, documents, row } = harness();
    const result = await service.saveAttachments(ctx, {
      clientId: CLIENT, conversationId: CONVERSATION, attachmentIds: [FILE],
    });
    expect(documents.createAttachmentFromBuffer).toHaveBeenCalledWith(ctx, expect.objectContaining({
      buffer: row.data, clientId: CLIENT, sourceEntityId: FILE,
      sourceEntityType: 'clio_attachment', untrustedUpload: true,
    }));
    expect(tx.clioAttachment.findMany).toHaveBeenCalledWith({ where: {
      id: { in: [FILE] }, tenantId: ctx.tenantId, userId: ctx.userId,
      messageId: { in: ['message'] },
    } });
    expect(tx.clioMessage.findMany).toHaveBeenCalledWith({ where: {
      conversationId: CONVERSATION, tenantId: ctx.tenantId, userId: ctx.userId, role: 'user',
    }, select: { id: true } });
    expect(result).toMatchObject({ status: 'saved', savedCount: 1,
      clientName: 'Sightline Intelligence', files: [{ documentId: 'durable-document', indexingStatus: 'pending' }] });
    expect(result.location).toBe(`/clients?clientId=${CLIENT}&tab=documents`);
  });

  it('retains successful siblings and only retries the same source identity after a partial save', async () => {
    const { service, tx, documents, row } = harness();
    tx.clioAttachment.findMany.mockResolvedValue([row, { ...row, id: FILE2 }]);
    documents.createAttachmentFromBuffer.mockResolvedValueOnce({ id: 'first', lifecycleStatus: 'ready' })
      .mockRejectedValueOnce(new Error('database unavailable'));
    const input = { clientId: CLIENT, conversationId: CONVERSATION, attachmentIds: [FILE, FILE2] };
    const first = await service.saveAttachments(ctx, input);
    expect(first).toMatchObject({ status: 'partial', savedCount: 1, failedCount: 1 });
    expect(first.files[1]).not.toHaveProperty('documentId');
    await service.saveAttachments(ctx, input);
    expect(documents.createAttachmentFromBuffer.mock.calls[0][1].idempotencyKey)
      .toBe(documents.createAttachmentFromBuffer.mock.calls[2][1].idempotencyKey);
  });

  it('does not claim a scan-pending stored original is ready', async () => {
    const { service, documents } = harness();
    documents.createAttachmentFromBuffer.mockResolvedValue({ id: 'pending-doc', lifecycleStatus: 'quarantined' });
    const result = await service.saveAttachments(ctx, { clientId: CLIENT,
      conversationId: CONVERSATION, attachmentIds: [FILE] });
    expect(result).toMatchObject({ status: 'pending', savedCount: 0, pendingCount: 1,
      files: [{ status: 'pending', documentId: 'pending-doc' }] });
  });

  it('reports unavailable historical originals without rebuilding them from extracted text', async () => {
    const { service, tx, documents, row } = harness();
    tx.clioAttachment.findMany.mockResolvedValue([{ ...row, data: null, textContent: 'partial text' }]);
    const result = await service.saveAttachments(ctx, { clientId: CLIENT,
      conversationId: CONVERSATION, attachmentIds: [FILE] });
    expect(result).toMatchObject({ status: 'failed', savedCount: 0 });
    expect(result.files[0]!.reason).toMatch(/Reattach/);
    expect(documents.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('refuses attachments excluded by the tenant/user/conversation-message authorization query', async () => {
      const { service, tx, documents } = harness();
      tx.clioAttachment.findMany.mockResolvedValue([]);
      const result = await service.saveAttachments(ctx, { clientId: CLIENT,
        conversationId: CONVERSATION, attachmentIds: [FILE] });
      expect(result.status).toBe('failed');
      expect(result.files[0]!.fileName).toBeNull();
      expect(documents.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('checks client walls and conversation ownership before any document write', async () => {
    const { service, tx, documents } = harness();
    tx.$queryRawUnsafe.mockResolvedValue([{ id: CLIENT }]);
    await expect(service.saveNote(ctx, { clientId: CLIENT, body: 'Wyden notes' }))
      .rejects.toBeInstanceOf(NotFoundException);
    tx.$queryRawUnsafe.mockResolvedValue([]);
    tx.clioConversation.findFirst.mockResolvedValue(null);
    await expect(service.saveNote(ctx, { clientId: CLIENT, conversationId: CONVERSATION, body: 'Wyden notes' }))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(documents.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('rejects wrong-client conversations and blank notes before mutation', async () => {
    const { service, tx, documents } = harness();
    await expect(service.saveNote(ctx, { clientId: CLIENT, body: '   ' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.saveNote(ctx, { clientId: CLIENT, body: 'x'.repeat(40_001) }))
      .rejects.toBeInstanceOf(BadRequestException);
    tx.clioConversation.findFirst.mockResolvedValue({ id: CONVERSATION, clientId: 'other-client' });
    await expect(service.saveNote(ctx, { clientId: CLIENT, conversationId: CONVERSATION, body: 'Wyden notes' }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(documents.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });

  it('only returns a client note receipt after a confirmed canonical write, preserving privacy', async () => {
    const { service, documents } = harness();
    const input = { clientId: CLIENT, conversationId: CONVERSATION,
      title: 'Sen. Wyden engagement', body: 'Discussed FY2027 draft priorities.', confidential: true };
    documents.createAttachmentFromBuffer.mockRejectedValueOnce(new Error('S3 unavailable'));
    await expect(service.saveNote(ctx, input)).rejects.toThrow('S3 unavailable');
    const result = await service.saveNote(ctx, input);
    expect(result).toMatchObject({ status: 'saved', documentId: 'durable-document',
      clientId: CLIENT, clientName: 'Sightline Intelligence', note: { body: input.body }, indexingStatus: 'not_indexed' });
    expect(documents.createAttachmentFromBuffer).toHaveBeenLastCalledWith(ctx,
      expect.objectContaining({ privateToUploader: true, contentType: 'text/plain',
        buffer: Buffer.from(input.body), source: 'meri_note', untrustedUpload: true }));
  });

  it.each([['quarantined', 'pending'], ['blocked', 'failed']])(
    'does not report a ready note for lifecycle %s', async (lifecycleStatus, status) => {
      const { service, documents } = harness();
      documents.createAttachmentFromBuffer.mockResolvedValue({ id: 'stored-note', fileName: 'note.txt', lifecycleStatus });
      expect(await service.saveNote(ctx, { clientId: CLIENT, body: 'Wyden notes' }))
        .toMatchObject({ status, documentId: 'stored-note', indexingStatus: 'not_indexed' });
    },
  );
});
