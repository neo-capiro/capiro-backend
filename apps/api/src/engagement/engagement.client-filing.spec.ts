import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';
import { AttachmentContentService } from './attachment-content.service.js';

const ctx = { tenantId: 'tenant-one', userId: 'user-one' } as TenantContext;
const input = { clientId: 'client-one', fileName: 'brief.txt', contentType: 'text/plain',
  buffer: Buffer.from('original client brief'), source: 'meri_chat_attachment',
  idempotencyKey: 'attachment-one', untrustedUpload: true };

function harness() {
  const rows = new Map<string, Record<string, unknown>>();
  const tx = { engagementAttachment: {
    findFirst: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
    upsert: jest.fn(async ({ where, create }) => {
      if (!rows.has(where.id)) rows.set(where.id, { lifecycleStatus: 'legacy_ready', ...create });
      return rows.get(where.id);
    }),
    create: jest.fn(async ({ data }) => ({ id: 'generated', lifecycleStatus: 'legacy_ready', ...data })),
  } };
  const s3 = { send: jest.fn().mockResolvedValue({}) };
  const scanner = { getStatus: jest.fn().mockResolvedValue('clean'), scanRequired: true, providerName: 'test' };
  const content = { detectContentType: jest.fn().mockReturnValue('text/plain'),
    contentTypeConflicts: jest.fn().mockReturnValue(false), sha256: jest.fn().mockReturnValue('server-digest') };
  const clientKb = { indexAttachmentFireAndForget: jest.fn() };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    bucket: 'test-bucket', s3, scanner, attachmentContent: content,
    prisma: { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) },
    validateAttachmentParents: jest.fn().mockResolvedValue(undefined),
    attachmentClientAtWrite: jest.fn(async (_tx, _ctx, args) => args.clientId),
    clientKb,
  });
  return { service, rows, tx, s3, scanner, content, clientKb };
}

describe('canonical client document retry and scan boundary', () => {
  it('uses one durable document and object key for concurrent retries', async () => {
    const { service, rows, s3 } = harness();
    const [first, concurrent] = await Promise.all([
      service.createAttachmentFromBuffer(ctx, input), service.createAttachmentFromBuffer(ctx, input),
    ]);
    const retry = await service.createAttachmentFromBuffer(ctx, input);
    expect(first.id).toBe(concurrent.id);
    expect(retry).toMatchObject({ id: first.id, reused: true });
    const retitled = await service.createAttachmentFromBuffer(ctx, { ...input, fileName: 'new-title.txt' });
    expect(retitled).toMatchObject({ id: first.id, fileName: input.fileName, reused: true });
    expect(rows.size).toBe(1);
    expect(new Set(s3.send.mock.calls.map(([command]) => command.input.Key)).size).toBe(1);
    expect([...rows.values()][0]).toMatchObject({ lifecycleStatus: 'ready',
      scanStatus: 'clean', calculatedSha256: 'server-digest', uploadedByUserId: ctx.userId });
  });

  it('recovers after S3 succeeded but the DB write failed without a new object or document identity', async () => {
    const { service, tx, s3, rows } = harness();
    tx.engagementAttachment.upsert.mockRejectedValueOnce(new Error('database timeout'));
    await expect(service.createAttachmentFromBuffer(ctx, input)).rejects.toThrow('database timeout');
    const retry = await service.createAttachmentFromBuffer(ctx, input);
    expect(rows.size).toBe(1);
    expect(retry.id).toBe(tx.engagementAttachment.upsert.mock.calls[0]![0].where.id);
    expect(s3.send.mock.calls[0][0].input.Key).toBe(s3.send.mock.calls[1][0].input.Key);
  });

  it('recovers the authorized winner of an emulated concurrent upsert collision', async () => {
    const { service, tx, rows } = harness();
    tx.engagementAttachment.upsert.mockImplementationOnce(async ({ where, create }) => {
      rows.set(where.id, create);
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint', { code: 'P2002', clientVersion: 'test' });
    });
    const saved = await service.createAttachmentFromBuffer(ctx, input);
    expect(rows.size).toBe(1);
    expect(saved.id).toBe([...rows.keys()][0]);
    expect(tx.engagementAttachment.findFirst).toHaveBeenLastCalledWith({ where: {
      id: saved.id, tenantId: ctx.tenantId, clientId: input.clientId, uploadedByUserId: ctx.userId,
    } });
  });

  it('binds retry identity to tenant, uploader, client and content', async () => {
    const { service, rows } = harness();
    await service.createAttachmentFromBuffer(ctx, input);
    await service.createAttachmentFromBuffer({ ...ctx, tenantId: 'tenant-two' }, input);
    await service.createAttachmentFromBuffer({ ...ctx, userId: 'user-two' }, input);
    await service.createAttachmentFromBuffer(ctx, { ...input, clientId: 'client-two' });
    await service.createAttachmentFromBuffer(ctx, { ...input, buffer: Buffer.from('changed') });
    expect(rows.size).toBe(5);
  });

  it.each([
    ['pending', 'quarantined'], ['threat', 'blocked'], ['failed', 'blocked'],
    ['scanner_not_required', 'blocked'],
  ])('retains canonical fail-closed readiness for scan status %s', async (scan, lifecycle) => {
    const { service, scanner, clientKb } = harness();
    scanner.getStatus.mockResolvedValue(scan);
    expect(await service.createAttachmentFromBuffer(ctx, input))
      .toMatchObject({ lifecycleStatus: lifecycle, scanStatus: scan });
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });

  it('rejects a type mismatch before sending any original bytes to S3', async () => {
    const { service, content, s3 } = harness();
    content.contentTypeConflicts.mockReturnValue(true);
    await expect(service.createAttachmentFromBuffer(ctx, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('keeps generated document behavior and honors private note ACLs', async () => {
    const { service, scanner, tx, clientKb } = harness();
    await service.createAttachmentFromBuffer(ctx, {
      ...input, untrustedUpload: false, privateToUploader: true,
    });
    expect(scanner.getStatus).not.toHaveBeenCalled();
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
    expect(tx.engagementAttachment.upsert.mock.calls[0]![0].create).toMatchObject({
      viewerMode: 'restricted', viewerUserIds: [ctx.userId],
    });
  });

  it('reopens the saved note through the canonical document reader with its exact body', async () => {
    const { service, scanner } = harness();
    scanner.scanRequired = false;
    Object.assign(service, {
      attachmentContent: new AttachmentContentService(),
      readAttachmentBytes: jest.fn().mockResolvedValue(input.buffer),
      recordExtractionOutcome: jest.fn().mockResolvedValue(undefined),
    });
    const saved = await service.createAttachmentFromBuffer(ctx, { ...input, untrustedUpload: false });
    const reopened = await service.extractAttachmentText(ctx, saved.id, {
      clientId: input.clientId, section: 1,
    });
    expect(reopened).toMatchObject({ attachmentId: saved.id, text: input.buffer.toString('utf8'),
      fileName: input.fileName });
  });
});
