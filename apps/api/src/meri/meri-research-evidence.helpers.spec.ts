import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { wrapToolResultForPrompt } from '@capiro/meriv2-core';
import { getResearchEvidence } from './meri-research-evidence.helpers';
import type { MeriResearchHandoff } from './meri-research-handoff';

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;
const sessionId = '11111111-1111-4111-8111-111111111111';
const clientId = '22222222-2222-4222-8222-222222222222';
const otherClientId = '33333333-3333-4333-8333-333333333333';
const id = (n: number) => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

function fixture(count = 12) {
  const attachments: MeriResearchHandoff['attachments'] = Array.from({ length: count }, (_, i) => ({
    id: id(i),
    sourceMessageId: null,
    filename: `Evidence ${i}.txt`,
    kind: 'text',
    status: 'parsed',
    reason: null,
    textContent: `Immutable evidence ${i}`,
    mediaType: 'text/plain',
    byteSize: 30,
    source: `clio_attachment:${id(i)}`,
    contentSha256: createHash('sha256').update(`Immutable evidence ${i}`).digest('hex'),
  }));
  const handoff = {
    version: 1,
    capturedAt: '2026-09-06T00:00:00Z',
    conversationId: null,
    clientId,
    attachments,
    messages: [{ body: 'PRIVATE HISTORY MUST NOT RETURN' }],
  };
  const tx = {
    clioResearchSession: {
      findFirst: jest.fn().mockResolvedValue({ id: sessionId, clientId, metadata: { handoff } }),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    clioConversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation' }) },
    clioAttachment: {
      findMany: jest.fn(async (query: { where: { id: { in: string[] } } }) =>
        query.where.id.in.map((attachmentId) => {
          const attachment = attachments.find((candidate) => candidate.id === attachmentId)!;
          return {
            id: attachmentId,
            messageId: attachment.sourceMessageId,
            kind: attachment.kind,
            status: attachment.status,
            mediaType: attachment.mediaType,
            data: null,
            textContent: attachment.textContent,
          };
        }),
      ),
    },
    clioMessage: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = {
    withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) =>
      run(tx),
    ),
  };
  const read = (input: Record<string, unknown> = {}) =>
    getResearchEvidence(ctx, { sessionId, clientId, ...input }, prisma as never);
  return { tx, prisma, read, handoff, attachments };
}

describe('get_research_evidence immutable source tool', () => {
  it('pages all snapshot attachments, preserving original IDs/text and omitting history and bytes', async () => {
    const f = fixture();
    const first = await f.read({ limit: 10 });
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(
      ctx.tenantId,
      ctx.userId,
      expect.any(Function),
    );
    expect(f.tx.clioResearchSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId },
      }),
    );
    expect(f.tx.clioAttachment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: f.attachments.slice(0, 10).map((row) => row.id) },
          tenantId: ctx.tenantId,
          userId: ctx.userId,
        },
      }),
    );
    expect(first.coverage).toMatchObject({
      total: 12,
      returned: 10,
      status: 'partial',
      truncated: true,
    });
    expect(first.records[0]).toMatchObject({
      recordId: id(0),
      payload: { textContent: 'Immutable evidence 0', title: 'Evidence 0.txt' },
    });
    const second = await f.read({ limit: 10, cursor: first.coverage.nextCursor });
    expect(second.records.map((row) => row.recordId)).toEqual([id(10), id(11)]);
    expect(second.coverage).toMatchObject({
      total: 12,
      returned: 2,
      status: 'complete',
      nextCursor: null,
    });
    expect(JSON.stringify(first)).not.toContain('PRIVATE HISTORY');
    expect(JSON.stringify(first)).not.toContain('"data"');
  });

  it('limits reads to explicitly selected original attachment IDs', async () => {
    const f = fixture();
    const result = await f.read({ attachmentIds: [id(10)] });
    expect(result.records.map((row) => row.recordId)).toEqual([id(10)]);
    expect(result.coverage).toMatchObject({ total: 1, complete: true });
    await expect(f.read({ attachmentIds: [id(99)] })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('denies a missing/other-owner session without reading its attachments', async () => {
    const f = fixture();
    f.tx.clioResearchSession.findFirst.mockResolvedValue(null);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('rejects client mismatch and revoked walls before returning evidence', async () => {
    const f = fixture();
    await expect(f.read({ clientId: otherClientId })).rejects.toBeInstanceOf(NotFoundException);
    f.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('fails closed when the wall cannot be checked', async () => {
    const f = fixture();
    f.tx.$queryRawUnsafe.mockRejectedValue(new Error('wall unavailable'));
    await expect(f.read()).rejects.toThrow('wall unavailable');
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('rejects evidence whose attachment was deleted or is no longer owned', async () => {
    const f = fixture();
    f.tx.clioAttachment.findMany.mockResolvedValue([]);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects changed current extracted text instead of replaying stale snapshot bytes', async () => {
    const f = fixture(1);
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: id(0),
        messageId: null,
        kind: 'text',
        status: 'parsed',
        mediaType: 'text/plain',
        data: null,
        textContent: 'changed bytes',
      },
    ] as never);
    await expect(f.read()).rejects.toThrow('changed since the snapshot');
  });

  it('requires the originating conversation to remain in the snapshot client scope', async () => {
    const f = fixture();
    Object.assign(f.handoff, { conversationId: id(20) });
    f.tx.clioConversation.findFirst.mockResolvedValue(null);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('validates ready image digests and returns only image metadata', async () => {
    const f = fixture(1);
    const bytes = Buffer.from('verified-image');
    Object.assign(f.attachments[0]!, {
      kind: 'image',
      status: 'image_ready',
      textContent: null,
      mediaType: 'image/png',
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: id(0),
        messageId: null,
        kind: 'image',
        status: 'image_ready',
        mediaType: 'image/png',
        data: bytes,
        textContent: '',
      },
    ] as never);
    const result = await f.read();
    expect(result.records[0]?.payload).toMatchObject({ kind: 'image', textContent: null });
    expect(JSON.stringify(result)).not.toContain(bytes.toString('base64'));
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: id(0),
        messageId: null,
        kind: 'image',
        status: 'image_ready',
        mediaType: 'image/png',
        data: Buffer.from('changed'),
        textContent: '',
      },
    ] as never);
    await expect(f.read()).rejects.toThrow('changed since the snapshot');
  });

  it('returns verified canonical text when snapshot text differs from its digest', async () => {
    const f = fixture(1);
    const canonicalText = f.attachments[0]!.textContent!;
    const snapshotDigest = f.attachments[0]!.contentSha256;
    f.attachments[0]!.textContent = 'UNTRUSTED snapshot sentinel';
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: id(0),
        messageId: null,
        kind: 'text',
        status: 'parsed',
        mediaType: 'text/plain',
        data: null,
        textContent: canonicalText,
      },
    ] as never);
    const result = await f.read();
    expect(result.records[0]?.payload.textContent).toBe(canonicalText);
    expect(createHash('sha256').update(result.records[0]?.payload.textContent!).digest('hex')).toBe(
      snapshotDigest,
    );
    expect(JSON.stringify(result)).not.toContain('UNTRUSTED snapshot sentinel');
  });

  it('distinguishes incomplete extraction from complete pagination', async () => {
    const f = fixture(1);
    f.attachments[0]!.status = 'truncated';
    const result = await f.read();
    expect(result.coverage).toMatchObject({
      status: 'partial',
      contentComplete: false,
      paginationComplete: true,
      complete: false,
    });
  });

  it('does not forget incomplete extraction on an earlier page when pagination finishes', async () => {
    const f = fixture();
    f.attachments[0]!.status = 'truncated';
    const first = await f.read({ limit: 10 });
    const final = await f.read({ limit: 10, cursor: first.coverage.nextCursor });
    expect(final.coverage).toMatchObject({
      paginationComplete: true,
      contentComplete: false,
      complete: false,
    });
  });

  it('keeps cursor and coverage visible before large text through the real prompt cap', async () => {
    const f = fixture();
    f.attachments[0]!.textContent = 'x'.repeat(30000);
    f.attachments[0]!.contentSha256 = createHash('sha256')
      .update(f.attachments[0]!.textContent!)
      .digest('hex');
    const result = await f.read({ limit: 1 });
    const prompt = wrapToolResultForPrompt('get_research_evidence', result, 12000);
    expect(prompt).toContain(result.coverage.nextCursor);
    expect(prompt).toContain('"complete": false');
    expect(prompt).toContain('[truncated tool result]');
  });

  it('rejects invalid IDs, excess attachments and cross-selection cursors', async () => {
    const f = fixture();
    const first = await f.read({ limit: 1 });
    for (const input of [
      { sessionId: 'bad' },
      { limit: 11 },
      { attachmentIds: f.attachments.map((row) => row.id) },
      { cursor: first.coverage.nextCursor, attachmentIds: [id(0)] },
      { cursor: first.coverage.nextCursor, sessionId: otherClientId },
    ]) {
      await expect(f.read(input)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('emits current extracted text that hashes to the snapshot digest (matching snapshot/current)', async () => {
    const f = fixture(1);
    const result = await f.read();
    expect(result.records[0]?.payload.textContent).toBe('Immutable evidence 0');
  });

  it('denies when snapshot hash does not match actual persisted text hash', async () => {
    const f = fixture(1);
    const attachment = f.attachments[0]!;
    // Keep the snapshot with correct text and hash
    // But mock DB to return different text (will fail hash check)
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: id(0),
        messageId: null,
        kind: 'text',
        status: 'parsed',
        mediaType: 'text/plain',
        data: null,
        textContent: 'changed bytes',
      },
    ] as never);
    await expect(f.read()).rejects.toThrow('changed since the snapshot');
  });

  it('withholds evidence when wall withdrawal occurs after attachments are read', async () => {
    const f = fixture(1);
    f.tx.$queryRawUnsafe
      .mockResolvedValueOnce([{ allowed: true }])
      .mockResolvedValueOnce([{ allowed: false }]);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).toHaveBeenCalledTimes(1);
    expect(f.tx.$queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it('denies when source message ID differs between snapshot and current', async () => {
    const f = fixture(1);
    // Add conversationId and messageId so we get to the source message check
    Object.assign(f.handoff, { conversationId: id(20) });
    const attachment = f.attachments[0]!;
    // Set sourceMessageId in the snapshot to a different value than the live attachment's messageId
    Object.assign(attachment, { sourceMessageId: id(88) });
    // Mock the live attachment to have a messageId that exists in DB
    const liveMessageId = id(77);
    f.tx.clioAttachment.findMany.mockResolvedValue([
      {
        id: attachment.id,
        messageId: liveMessageId,
        kind: 'text',
        status: 'parsed',
        mediaType: 'text/plain',
        data: null,
        textContent: attachment.textContent,
      },
    ] as never);
    // Mock conversation to exist
    f.tx.clioConversation.findFirst.mockResolvedValue({ id: id(20) });
    // Mock message to return the live message (satisfies count check)
    f.tx.clioMessage.findMany.mockResolvedValue([{ id: liveMessageId }]);
    // The source message ID mismatch happens at line 109-110:
    // attachment.sourceMessageId (id(88)) !== current.messageId (id(77))
    await expect(f.read()).rejects.toThrow('source message');
  });

  it('denies when conversation was revoked (wall withdrawal after snapshot)', async () => {
    const f = fixture(1);
    Object.assign(f.handoff, { conversationId: id(20) });
    f.tx.clioConversation.findFirst.mockResolvedValue(null);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('denies when client scope was revoked after snapshot', async () => {
    const f = fixture(1);
    f.tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    await expect(f.read()).rejects.toBeInstanceOf(NotFoundException);
    expect(f.tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });
});
