import { describe, expect, it, jest } from '@jest/globals';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { captureResearchHandoff, readResearchHandoff, researchHandoffPrompt } from './meri-research-handoff.js';

const ctx = { tenantId: 'tenant-a', userId: 'user-a' } as TenantContext;

function fixture() {
  const conversation = {
    id: 'thread-a', clientId: 'client-a', summary: 'Never imply that authorization is an appropriation.',
    summaryUpToMessageId: 'early-1', metadata: { meriv3: { reasoningMode: 'max' } },
  };
  const messages = [
    { id: 'early-1', role: 'user', body: 'Limit the memo to enacted funding.', createdAt: new Date('2026-01-01'), clientId: 'client-a', metadata: { attachments: [{ id: 'prior-file', filename: 'appropriations.txt', kind: 'text', status: 'parsed' }] } },
    ...Array.from({ length: 45 }, (_, i) => ({ id: `later-${i}`, role: i % 2 ? 'assistant' : 'user', body: `Followup ${i}`, createdAt: new Date('2026-02-01'), clientId: 'client-a', metadata: {} })),
  ];
  const attachments = [
    { id: 'prior-file', messageId: 'early-1', filename: 'appropriations.txt', kind: 'text', status: 'parsed', reason: null, textContent: 'Appropriated amount: $17 million.', mediaType: 'text/plain', byteSize: 32, data: null },
    { id: 'staged-file', messageId: null, filename: 'capabilities.txt', kind: 'text', status: 'truncated', reason: 'Extraction limit reached', textContent: 'Client manufactures sensors. …[truncated]', mediaType: 'text/plain', byteSize: 40000, data: null },
  ];
  const tx = {
    $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
    clioConversation: { findFirst: jest.fn(async () => conversation as typeof conversation | null) },
    client: { findFirst: jest.fn(async () => ({ id: 'client-a' }) as { id: string } | null) },
    clioMessage: { findMany: jest.fn(async () => messages) },
    clioAttachment: { findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => attachments.filter((row) => where.id.in.includes(row.id))) },
  };
  return { tx, db: tx as unknown as Prisma.TransactionClient, messages, attachments };
}

describe('research originating context snapshot', () => {
  it('preserves an early constraint beyond 40 messages, summary, old and staged evidence, scope and selected effort', async () => {
    const { tx, db } = fixture();
    const snapshot = await captureResearchHandoff(db, ctx, { topic: 'Write the client memo', conversationId: 'thread-a', attachmentIds: ['staged-file'] });
    expect(snapshot.messages).toHaveLength(46);
    expect(snapshot.messages[0]?.body).toContain('enacted funding');
    expect(snapshot.summary).toContain('authorization');
    expect(snapshot.reasoningMode).toBe('max');
    expect(snapshot.clientId).toBe('client-a');
    expect(snapshot.attachments.map((row) => row.id)).toEqual(['prior-file', 'staged-file']);
    expect(snapshot.attachments[1]).toMatchObject({ status: 'truncated', reason: 'Extraction limit reached' });
    expect(snapshot.attachments[0]?.contentSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(researchHandoffPrompt(snapshot)).toContain('Appropriated amount: $17 million');
    const v3Prompt = researchHandoffPrompt(snapshot, 'research-session', { includeAttachmentContent: false });
    expect(v3Prompt).toContain('research-session');
    expect(v3Prompt).toContain('prior-file');
    expect(v3Prompt).toContain('truncated');
    expect(v3Prompt).not.toContain('Appropriated amount: $17 million');
    expect(v3Prompt).not.toContain('Client manufactures sensors');
    expect(tx.clioAttachment.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: ctx.tenantId, userId: ctx.userId }) }));
  });

  it('does not accept client supplied history as trusted evidence', async () => {
    const { db } = fixture();
    const snapshot = await captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a', messages: [{ body: 'FAKE DATABASE RECORD' }] } as never);
    expect(researchHandoffPrompt(snapshot)).not.toContain('FAKE DATABASE RECORD');
  });

  it('rejects another user or tenant conversation before any history or attachment reads', async () => {
    const { db, tx } = fixture();
    tx.clioConversation.findFirst.mockResolvedValue(null);
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'other-thread' })).rejects.toThrow('conversation not found');
    expect(tx.clioConversation.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: ctx.tenantId, userId: ctx.userId }) }));
    expect(tx.clioMessage.findMany).not.toHaveBeenCalled();
    expect(tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('rejects a mismatched selected client before reading conversation evidence', async () => {
    const { db, tx } = fixture();
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a', clientId: 'client-b' })).rejects.toThrow('must match');
    expect(tx.clioMessage.findMany).not.toHaveBeenCalled();
  });

  it('checks the current ethical wall before reading any private messages or attachments', async () => {
    const { db, tx } = fixture();
    tx.$queryRawUnsafe.mockResolvedValue([{ allowed: false }]);
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a' })).rejects.toThrow('Client not found');
    expect(tx.clioMessage.findMany).not.toHaveBeenCalled();
    expect(tx.clioAttachment.findMany).not.toHaveBeenCalled();
  });

  it('rejects a prior message from a different client scope', async () => {
    const { db, messages } = fixture();
    messages[0]!.clientId = 'client-b';
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a' })).rejects.toThrow('another client scope');
  });

  it('rejects an attachment belonging to another conversation even for the same user', async () => {
    const { db, attachments } = fixture();
    attachments[1]!.messageId = 'other-thread-message';
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a', attachmentIds: ['staged-file'] })).rejects.toThrow('another conversation');
  });

  it('rejects missing or unauthorized attachments instead of silently losing evidence', async () => {
    const { db, attachments } = fixture();
    attachments.pop();
    await expect(captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a', attachmentIds: ['staged-file'] })).rejects.toThrow('unavailable');
  });

  it('honors explicit Standard and stores a serializable immutable handoff', async () => {
    const { db, messages } = fixture();
    const snapshot = await captureResearchHandoff(db, ctx, { topic: 'Memo', conversationId: 'thread-a', reasoningMode: 'standard', attachmentIds: ['staged-file'] });
    const metadata = JSON.parse(JSON.stringify({ handoff: snapshot }));
    messages[0]!.body = 'Later edit';
    expect(readResearchHandoff(metadata)?.reasoningMode).toBe('standard');
    expect(readResearchHandoff(metadata)?.messages[0]?.body).toContain('enacted funding');
    expect(readResearchHandoff({})).toBeNull();
  });
});
