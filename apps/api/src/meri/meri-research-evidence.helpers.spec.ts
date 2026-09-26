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
    id: id(i), sourceMessageId: null, filename: `Evidence ${i}.txt`, kind: 'text', status: 'parsed',
    reason: null, textContent: `Immutable evidence ${i}`, mediaType: 'text/plain', byteSize: 30,
    source: `clio_attachment:${id(i)}`, contentSha256: createHash('sha256').update(`Immutable evidence ${i}`).digest('hex'),
  }));
  const handoff = { version: 1, capturedAt: '2026-09-06T00:00:00Z', conversationId: null,
    clientId, attachments, messages: [{ body: 'PRIVATE HISTORY MUST NOT RETURN' }] };
  const tx = {
    clioResearchSession: { findFirst: jest.fn().mockResolvedValue({ id: sessionId, clientId, metadata: { handoff } }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ allowed: true }]),
    clioConversation: { findFirst: jest.fn().mockResolvedValue({ id: 'conversation' }) },
    clioAttachment: { findMany: jest.fn(async (query: { where: { id: { in: string[] } } }) =>
      query.where.id.in.map((attachmentId): { id: string; messageId: string | null; kind: string;
        status: string; mediaType: string; data: Buffer | null; textContent: string } => ({ id: attachmentId, messageId: null, kind: 'text',
        status: 'parsed', mediaType: 'text/plain', data: null, textContent: 'CURRENT TEXT MUST NOT REPLACE THE SNAPSHOT' }))) },
    clioMessage: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = { withTenantUser: jest.fn(async (_tenant: string, _user: string, run: (tx: unknown) => unknown) => run(tx)) };
  const read = (input: Record<string, unknown> = {}) => getResearchEvidence(ctx, { sessionId, clientId, ...input }, prisma as never);
  return { tx, prisma, read, handoff, attachments };
}

describe('get_research_evidence immutable source tool', () => {
  it('reads a three-attachment research lease through every page and preserves a known-value oracle', async () => {
    const f = fixture(3);
    const imageBytes = Buffer.from('known-image-bytes');
    Object.assign(f.handoff, { conversationId: id(30) });
    f.attachments[0]!.sourceMessageId = id(20);
    f.attachments[0]!.textContent = 'Appropriated amount: $17 million.';
    f.attachments[0]!.contentSha256 = createHash('sha256').update(f.attachments[0]!.textContent!).digest('hex');
    f.attachments[1]!.status = 'truncated';
    f.attachments[1]!.reason = 'Scanned page could not be fully extracted';
    f.attachments[1]!.textContent = 'Partial scan only.';
    f.attachments[1]!.contentSha256 = createHash('sha256').update(f.attachments[1]!.textContent!).digest('hex');
    Object.assign(f.attachments[2]!, { kind: 'image', status: 'image_ready', textContent: null,
      mediaType: 'image/png', contentSha256: createHash('sha256').update(imageBytes).digest('hex') });
    f.tx.clioMessage.findMany.mockResolvedValue([{ id: id(20) }] as never);
    f.tx.clioAttachment.findMany.mockImplementation(async (query: { where: { id: { in: string[] } } }) =>
      query.where.id.in.map((attachmentId) => ({ id: attachmentId,
        messageId: attachmentId === id(0) ? id(20) : null,
        kind: attachmentId === id(2) ? 'image' : 'text',
        status: attachmentId === id(2) ? 'image_ready' : attachmentId === id(1) ? 'truncated' : 'parsed',
        mediaType: attachmentId === id(2) ? 'image/png' : 'text/plain',
        data: attachmentId === id(2) ? imageBytes : null, textContent: 'Live content must not replace the snapshot',
      })));

    const pages = [];
    let cursor: string | null = null;
    do {
      const page = await f.read({ limit: 1, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.coverage.nextCursor;
    } while (cursor);
    expect(pages.map((page) => page.records[0]?.recordId)).toEqual([id(0), id(1), id(2)]);
    expect(pages[0]!.records[0]?.payload.textContent).toBe('Appropriated amount: $17 million.');
    expect(pages[0]!.records[0]?.provenance).toMatchObject({ originalAttachmentId: id(0), sessionId });
    expect(pages[0]!.coverage).toMatchObject({ paginationComplete: false, contentComplete: false, complete: false });
    expect(pages[2]!.coverage).toMatchObject({ paginationComplete: true, contentComplete: false, complete: false });
    expect(pages[2]!.records[0]?.payload).toMatchObject({ kind: 'image', textContent: null });
    expect(JSON.stringify(pages)).not.toContain(imageBytes.toString('base64'));
    const selected = await f.read({ attachmentIds: [id(0)] });
    expect(selected.coverage).toMatchObject({ total: 1, complete: true });
    expect(wrapToolResultForPrompt('get_research_evidence', selected, 12000)).toContain('Appropriated amount: $17 million.');
    expect(f.tx.clioConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: id(30), tenantId: ctx.tenantId, userId: ctx.userId, clientId, archivedAt: null }),
    }));
  });

  it('pages all snapshot attachments, preserving original IDs/text and omitting history and bytes', async () => {
    const f = fixture();
    const first = await f.read({ limit: 10 });
    expect(f.prisma.withTenantUser).toHaveBeenCalledWith(ctx.tenantId, ctx.userId, expect.any(Function));
    expect(f.tx.clioResearchSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: sessionId, tenantId: ctx.tenantId, userId: ctx.userId } }));
    expect(f.tx.clioAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: { in: f.attachments.slice(0, 10).map((row) => row.id) }, tenantId: ctx.tenantId, userId: ctx.userId,
    } }));
    expect(first.coverage).toMatchObject({ total: 12, returned: 10, status: 'partial', truncated: true });
    expect(first.records[0]).toMatchObject({ recordId: id(0), payload: { textContent: 'Immutable evidence 0', title: 'Evidence 0.txt' } });
    const second = await f.read({ limit: 10, cursor: first.coverage.nextCursor });
    expect(second.records.map((row) => row.recordId)).toEqual([id(10), id(11)]);
    expect(second.coverage).toMatchObject({ total: 12, returned: 2, status: 'complete', nextCursor: null });
    expect(JSON.stringify(first)).not.toContain('PRIVATE HISTORY');
    expect(JSON.stringify(first)).not.toContain('CURRENT TEXT');
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

  it('rejects reparented staged attachments and changed immutable text', async () => {
    const f = fixture(1);
    Object.assign(f.handoff, { conversationId: id(30) });
    f.tx.clioMessage.findMany.mockResolvedValue([{ id: id(20) }] as never);
    f.tx.clioAttachment.findMany.mockResolvedValue([{ id: id(0), messageId: id(20), kind: 'text',
      status: 'parsed', mediaType: 'text/plain', data: null }] as never);
    await expect(f.read()).rejects.toThrow('source message');
    f.tx.clioAttachment.findMany.mockResolvedValue([{ id: id(0), messageId: null, kind: 'text',
      status: 'parsed', mediaType: 'text/plain', data: null }] as never);
    f.attachments[0]!.textContent = 'Changed snapshot text';
    await expect(f.read()).rejects.toThrow('Research text changed');
  });

  it('invalidates a cursor when the selected snapshot changes or its anchor disappears', async () => {
    const f = fixture(3);
    const first = await f.read({ limit: 1 });
    f.attachments[0]!.status = 'truncated';
    await expect(f.read({ limit: 1, cursor: first.coverage.nextCursor })).rejects.toThrow('cursor no longer matches');
    f.attachments[0]!.status = 'parsed';
    f.attachments.shift();
    await expect(f.read({ limit: 1, cursor: first.coverage.nextCursor })).rejects.toThrow('cursor no longer matches');
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
    Object.assign(f.attachments[0]!, { kind: 'image', status: 'image_ready', textContent: null,
      mediaType: 'image/png', contentSha256: createHash('sha256').update(bytes).digest('hex') });
    f.tx.clioAttachment.findMany.mockResolvedValue([{ id: id(0), messageId: null, kind: 'image',
      status: 'image_ready', mediaType: 'image/png', data: bytes, textContent: '' }] as never);
    const result = await f.read();
    expect(result.records[0]?.payload).toMatchObject({ kind: 'image', textContent: null });
    expect(JSON.stringify(result)).not.toContain(bytes.toString('base64'));
    f.tx.clioAttachment.findMany.mockResolvedValue([{ id: id(0), messageId: null, kind: 'image',
      status: 'image_ready', mediaType: 'image/png', data: Buffer.from('changed'), textContent: '' }] as never);
    await expect(f.read()).rejects.toThrow('changed since the snapshot');
  });

  it('distinguishes incomplete extraction from complete pagination', async () => {
    const f = fixture(1);
    f.attachments[0]!.status = 'truncated';
    const result = await f.read();
    expect(result.coverage).toMatchObject({ status: 'partial', contentComplete: false, paginationComplete: true, complete: false });
  });

  it('does not forget incomplete extraction on an earlier page when pagination finishes', async () => {
    const f = fixture();
    f.attachments[0]!.status = 'truncated';
    const first = await f.read({ limit: 10 });
    const final = await f.read({ limit: 10, cursor: first.coverage.nextCursor });
    expect(final.coverage).toMatchObject({ paginationComplete: true, contentComplete: false, complete: false });
  });

  it('keeps cursor and coverage visible before large text through the real prompt cap', async () => {
    const f = fixture();
    f.attachments[0]!.textContent = 'x'.repeat(30000);
    f.attachments[0]!.contentSha256 = createHash('sha256').update(f.attachments[0]!.textContent!).digest('hex');
    const result = await f.read({ limit: 1 });
    const prompt = wrapToolResultForPrompt('get_research_evidence', result, 12000);
    expect(prompt).toContain(result.coverage.nextCursor);
    expect(prompt).toContain('"complete": false');
    expect(prompt).toContain('[truncated tool result]');
  });

  it('rejects invalid IDs, excess attachments and cross-selection cursors', async () => {
    const f = fixture();
    const first = await f.read({ limit: 1 });
    for (const input of [{ sessionId: 'bad' }, { limit: 11 }, { attachmentIds: f.attachments.map((row) => row.id) },
      { cursor: first.coverage.nextCursor, attachmentIds: [id(0)] }, { cursor: first.coverage.nextCursor, sessionId: otherClientId }]) {
      await expect(f.read(input)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});
