import { BadRequestException, ConflictException } from '@nestjs/common';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService, type NativeClientDocumentWrite } from './engagement.service.js';
import { AttachmentContentService } from './attachment-content.service.js';

const ctx = { tenantId: 'tenant-one', userId: 'user-one' } as TenantContext;
const input = { clientId: 'client-one', fileName: 'brief.txt', contentType: 'text/plain',
  buffer: Buffer.from('original client brief'), source: 'meri_chat_attachment',
  idempotencyKey: 'attachment-one', untrustedUpload: true };

function harness() {
  const rows = new Map<string, Record<string, unknown>>();
  const tx = { $executeRaw: jest.fn(async (_query: Prisma.Sql) => 1), engagementAttachment: {
    findFirst: jest.fn(async ({ where }) => rows.get(where.id) ?? null),
    upsert: jest.fn(async ({ where, create }) => {
      if (!rows.has(where.id)) rows.set(where.id, { lifecycleStatus: 'legacy_ready', ...create });
      return rows.get(where.id);
    }),
    create: jest.fn(async ({ data }) => {
      const row = { id: 'generated', lifecycleStatus: 'legacy_ready', ...data };
      rows.set(row.id, row);
      return row;
    }),
  } };
  const s3 = { send: jest.fn().mockResolvedValue({}) };
  const scanner = { getStatus: jest.fn().mockResolvedValue('clean'), scanRequired: true, providerName: 'test' };
  const content = { detectContentType: jest.fn().mockReturnValue('text/plain'),
    contentTypeConflicts: jest.fn().mockReturnValue(false), sha256: jest.fn().mockReturnValue('server-digest') };
  const clientKb = { indexAttachmentFireAndForget: jest.fn() };
  const prisma = { withTenant: jest.fn(async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx)) };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    bucket: 'test-bucket', s3, scanner, attachmentContent: content,
    prisma,
    validateAttachmentParents: jest.fn().mockResolvedValue(undefined),
    attachmentClientAtWrite: jest.fn(async (_tx, _ctx, args) => args.clientId),
    clientKb,
  });
  return { service, rows, tx, s3, scanner, content, clientKb, prisma };
}

function nativeWrite(tx: ReturnType<typeof harness>['tx']): NativeClientDocumentWrite {
  return { tx: tx as unknown as Prisma.TransactionClient, beforeWrite: jest.fn(async () => {}),
    afterCommit: [], immutableObjectIdentity: 'a'.repeat(64) };
}

const byteHash = createHash('sha256').update(input.buffer).digest('hex');
const objectHead = { ContentLength: input.buffer.length, ContentType: input.contentType,
  ChecksumSHA256: Buffer.from(byteHash, 'hex').toString('base64') };
const preconditionFailed = () => Object.assign(new Error('Object already exists'), {
  name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 },
});

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

describe('native client filing uses the caller transaction and immutable object identity', () => {
  it('persists once, reuses across staging/name/MIME changes, and indexes only after commit', async () => {
    const { service, tx, rows, s3, scanner, clientKb, prisma } = harness();
    const internal = nativeWrite(tx);
    const first = await service.createAttachmentFromBuffer(ctx, input, internal);

    expect(prisma.withTenant).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledWith(expect.objectContaining({
      values: [`capiro-client-document:${first.id}`],
    }));
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.engagementAttachment.findFirst.mock.invocationCallOrder[0]!);
    expect(s3.send.mock.calls[0][0]).toBeInstanceOf(PutObjectCommand);
    expect(s3.send.mock.calls[0][0].input).toMatchObject({ IfNoneMatch: '*',
      ChecksumSHA256: objectHead.ChecksumSHA256, Body: input.buffer });
    expect(rows.get(first.id)).toMatchObject({ tenantId: ctx.tenantId, uploadedByUserId: ctx.userId,
      clientId: input.clientId, byteSize: input.buffer.length, calculatedSha256: byteHash, sourceContentHash: byteHash });
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
    expect(internal.afterCommit).toHaveLength(1);

    const nextApproval = nativeWrite(tx);
    const retry = await service.createAttachmentFromBuffer(ctx, { ...input,
      idempotencyKey: 'different-staging-upload', sourceEntityId: 'another-staging-id',
      fileName: 'renamed.md', contentType: 'text/markdown' }, nextApproval);
    expect(retry).toMatchObject({ id: first.id, fileName: input.fileName, reused: true });
    expect(rows.size).toBe(1);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(scanner.getStatus).toHaveBeenCalledTimes(1);
    expect(nextApproval.afterCommit).toHaveLength(0);
    internal.afterCommit.forEach((afterCommit) => afterCommit());
    expect(clientKb.indexAttachmentFireAndForget).toHaveBeenCalledTimes(1);
  });

  it('binds native document identity to the immutable object, tenant, actor, client and bytes', async () => {
    const { service, tx, rows } = harness();
    await service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx));
    await service.createAttachmentFromBuffer({ ...ctx, tenantId: 'tenant-two' }, input, nativeWrite(tx));
    await service.createAttachmentFromBuffer({ ...ctx, userId: 'user-two' }, input, nativeWrite(tx));
    await service.createAttachmentFromBuffer(ctx, { ...input, clientId: 'client-two' }, nativeWrite(tx));
    await service.createAttachmentFromBuffer(ctx, { ...input, buffer: Buffer.from('other bytes') }, nativeWrite(tx));
    await service.createAttachmentFromBuffer(ctx, input, { ...nativeWrite(tx), immutableObjectIdentity: 'b'.repeat(64) });
    expect(rows.size).toBe(6);
  });

  it.each([
    ['missing retry key', { idempotencyKey: undefined }],
    ['missing selected client', { clientId: null }],
    ['trusted-content bypass', { untrustedUpload: false }],
    ['wrong source hash', { sourceContentHash: 'b'.repeat(64) }],
  ] as const)('rejects %s before storage', async (_name, changes) => {
    const { service, tx, s3 } = harness();
    await expect(service.createAttachmentFromBuffer(ctx, { ...input, ...changes }, nativeWrite(tx)))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(s3.send).not.toHaveBeenCalled();
    expect(tx.engagementAttachment.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid immutable identity before calling authority or storage', async () => {
    const { service, tx, s3 } = harness();
    const internal = { ...nativeWrite(tx), immutableObjectIdentity: 'unverified' };
    await expect(service.createAttachmentFromBuffer(ctx, input, internal)).rejects.toBeInstanceOf(BadRequestException);
    expect(internal.beforeWrite).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });

  it.each([
    ['tenantId', 'another-tenant'], ['uploadedByUserId', 'another-user'], ['clientId', 'another-client'],
    ['byteSize', 1], ['calculatedSha256', 'b'.repeat(64)], ['sourceContentHash', 'b'.repeat(64)],
    ['bucket', 'another-bucket'], ['s3Key', 'another-key'], ['lifecycleStatus', 'delete_pending'],
    ['lifecycleStatus', 'delete_failed'], ['supersededByAttachmentId', 'replacement'],
  ])('refuses retained row mismatch %s=%s without new external effects', async (field, value) => {
    const { service, tx, rows, s3, scanner } = harness();
    const saved = await service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx));
    rows.get(saved.id)![field] = value;
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx))).rejects.toBeInstanceOf(ConflictException);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(scanner.getStatus).toHaveBeenCalledTimes(1);
  });

  it.each([['pending', 'quarantined'], ['threat', 'blocked']])('reuses %s scan state without rescanning or indexing', async (scan, lifecycleStatus) => {
    const { service, tx, scanner, s3, clientKb } = harness();
    scanner.getStatus.mockResolvedValue(scan);
    const internal = nativeWrite(tx);
    await service.createAttachmentFromBuffer(ctx, input, internal);
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx)))
      .resolves.toMatchObject({ reused: true, lifecycleStatus });
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(scanner.getStatus).toHaveBeenCalledTimes(1);
    expect(internal.afterCommit).toHaveLength(0);
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });

  it('observes an exact existing conditional object before scanning and persisting', async () => {
    const { service, tx, s3, scanner } = harness();
    s3.send.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce(objectHead);
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx))).resolves.toMatchObject({ lifecycleStatus: 'ready' });
    expect(s3.send.mock.calls[1][0]).toBeInstanceOf(HeadObjectCommand);
    expect(s3.send.mock.calls[1][0].input).toMatchObject({ ChecksumMode: 'ENABLED', Key: s3.send.mock.calls[0][0].input.Key });
    expect(scanner.getStatus).toHaveBeenCalledTimes(1);
    expect(tx.engagementAttachment.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ContentLength', 0], ['ChecksumSHA256', 'different'], ['ChecksumSHA256', undefined],
    ['ContentType', 'application/pdf'],
  ])('refuses a conditional collision with mismatched %s', async (field, value) => {
    const { service, tx, s3, scanner } = harness();
    s3.send.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce({ ...objectHead, [field]: value });
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx))).rejects.toBeInstanceOf(ConflictException);
    expect(s3.send).toHaveBeenCalledTimes(2);
    expect(scanner.getStatus).not.toHaveBeenCalled();
    expect(tx.engagementAttachment.create).not.toHaveBeenCalled();
  });

  it('keeps missing HEAD unknown and never sends an unconditional replacement', async () => {
    const { service, tx, s3 } = harness();
    const missing = Object.assign(new Error('No such object'), { $metadata: { httpStatusCode: 404 } });
    s3.send.mockRejectedValueOnce(preconditionFailed()).mockRejectedValueOnce(missing);
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx))).rejects.toBe(missing);
    expect(s3.send).toHaveBeenCalledTimes(2);
    expect(tx.engagementAttachment.create).not.toHaveBeenCalled();
  });

  it('does not turn a conflicting or ambiguous PUT into a new storage attempt', async () => {
    const { service, tx, s3 } = harness();
    const conflict = Object.assign(new Error('Concurrent storage operation'), { $metadata: { httpStatusCode: 409 } });
    s3.send.mockRejectedValueOnce(conflict);
    await expect(service.createAttachmentFromBuffer(ctx, input, nativeWrite(tx))).rejects.toBe(conflict);
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(tx.engagementAttachment.create).not.toHaveBeenCalled();
  });

  it('a new approved retry observes the same S3 key after database failure without overwriting', async () => {
    const { service, tx, s3, rows, clientKb } = harness();
    tx.engagementAttachment.create.mockRejectedValueOnce(new Error('database timeout'));
    const failed = nativeWrite(tx);
    await expect(service.createAttachmentFromBuffer(ctx, input, failed)).rejects.toThrow('database timeout');
    expect(rows.size).toBe(0);
    expect(failed.afterCommit).toHaveLength(0);
    const firstKey = s3.send.mock.calls[0][0].input.Key;
    s3.send.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce(objectHead);
    await service.createAttachmentFromBuffer(ctx, { ...input, idempotencyKey: 'fresh-upload' }, nativeWrite(tx));
    expect(rows.size).toBe(1);
    expect(s3.send.mock.calls[1][0].input).toMatchObject({ Key: firstKey, IfNoneMatch: '*' });
    expect(s3.send.mock.calls[2][0]).toBeInstanceOf(HeadObjectCommand);
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });

  it.each(['put', 'scan', 'parent'])('expiry after the %s await retains uncertainty without a database write', async (stage) => {
    const { service, tx, s3, scanner, rows, clientKb } = harness();
    const internal = nativeWrite(tx);
    let expired = false;
    internal.beforeWrite = jest.fn(async () => { if (expired) throw new Error('approval expired'); });
    if (stage === 'put') s3.send.mockImplementationOnce(async () => { expired = true; return {}; });
    else if (stage === 'scan') scanner.getStatus.mockImplementationOnce(async () => { expired = true; return 'clean'; });
    else Object.assign(service, { attachmentClientAtWrite: async () => { expired = true; return input.clientId; } });
    await expect(service.createAttachmentFromBuffer(ctx, input, internal)).rejects.toThrow('approval expired');
    expect(s3.send).toHaveBeenCalledTimes(1);
    expect(rows.size).toBe(0);
    expect(tx.engagementAttachment.create).not.toHaveBeenCalled();
    expect(internal.afterCommit).toHaveLength(0);
    expect(clientKb.indexAttachmentFireAndForget).not.toHaveBeenCalled();
  });

  it('rechecks authority after waiting for the document advisory lock', async () => {
    const { service, tx, s3 } = harness();
    const internal = nativeWrite(tx);
    let revoked = false;
    tx.$executeRaw.mockImplementationOnce(async () => { revoked = true; return 1; });
    internal.beforeWrite = jest.fn(async () => { if (revoked) throw new Error('approval revoked'); });
    await expect(service.createAttachmentFromBuffer(ctx, input, internal)).rejects.toThrow('approval revoked');
    expect(tx.engagementAttachment.findFirst).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });

  it('rechecks authority after waiting for an existing document lifecycle lock', async () => {
    const { service, tx, s3 } = harness();
    const internal = nativeWrite(tx);
    let revoked = false;
    tx.$executeRaw.mockImplementationOnce(async () => 1)
      .mockImplementationOnce(async () => { revoked = true; return 1; });
    internal.beforeWrite = jest.fn(async () => { if (revoked) throw new Error('approval revoked'); });
    await expect(service.createAttachmentFromBuffer(ctx, input, internal)).rejects.toThrow('approval revoked');
    expect(tx.$executeRaw.mock.calls[1]![0]).toMatchObject({ values: [ctx.tenantId, expect.any(String)] });
    expect(tx.engagementAttachment.findFirst).not.toHaveBeenCalled();
    expect(s3.send).not.toHaveBeenCalled();
  });
});
