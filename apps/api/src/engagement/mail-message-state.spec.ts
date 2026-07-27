import { describe, expect, it, jest } from '@jest/globals';
import { EngagementSource, type Prisma } from '@prisma/client';
import {
  activeMailMessageWhere,
  activeMailThreadWhere,
  markMailMessageRemovedInTx,
  recomputeMailThreadSummaryInTx,
} from './mail-message-state.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const MESSAGE = '33333333-3333-3333-3333-333333333333';

/** Minimal tx double covering only the model methods mail-message-state.ts calls. */
function fakeTx() {
  return {
    mailMessage: {
      findUnique: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
      findFirst: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(null),
      update: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
    },
    mailThread: {
      findUnique: jest
        .fn<(...args: unknown[]) => Promise<unknown>>()
        .mockResolvedValue({ metadata: {} }),
      update: jest.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({}),
    },
  };
}

type FakeTx = ReturnType<typeof fakeTx>;

function asTx(tx: FakeTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe('activeMailMessageWhere / activeMailThreadWhere', () => {
  it('excludes removed messages', () => {
    expect(activeMailMessageWhere()).toEqual({ removedAt: null });
  });

  it('excludes threads with no remaining active message', () => {
    expect(activeMailThreadWhere()).toEqual({
      messages: { some: { removedAt: null } },
    });
  });
});

describe('markMailMessageRemovedInTx', () => {
  it('marks a Gmail message removed, sets columns, and merges googleRemoved into existing metadata', async () => {
    const tx = fakeTx();
    tx.mailMessage.findUnique.mockResolvedValue({
      id: MESSAGE,
      threadId: THREAD,
      metadata: { labels: ['INBOX'] },
    });
    const removedAt = new Date('2026-07-27T12:00:00.000Z');

    const result = await markMailMessageRemovedInTx(asTx(tx), {
      tenantId: TENANT,
      source: EngagementSource.google,
      externalId: 'gmail-1',
      reason: 'trashed',
      removedAt,
      providerMetadata: { googleRemoved: { reason: 'trashed', at: removedAt.toISOString() } },
    });

    expect(result).toEqual({ found: true, threadId: THREAD });
    expect(tx.mailMessage.findUnique).toHaveBeenCalledWith({
      where: {
        tenantId_source_externalId: {
          tenantId: TENANT,
          source: EngagementSource.google,
          externalId: 'gmail-1',
        },
      },
      select: { id: true, threadId: true, metadata: true },
    });

    const updateCall = tx.mailMessage.update.mock.calls[0]?.[0] as {
      where: { id: string };
      data: { removedAt: Date; removedReason: string; metadata: Record<string, unknown> };
    };
    expect(updateCall.where).toEqual({ id: MESSAGE });
    expect(updateCall.data.removedAt).toBe(removedAt);
    expect(updateCall.data.removedReason).toBe('trashed');
    expect(updateCall.data.metadata).toEqual({
      labels: ['INBOX'],
      googleRemoved: { reason: 'trashed', at: removedAt.toISOString() },
    });
    // Recompute must run as part of the same removal.
    expect(tx.mailThread.update).toHaveBeenCalled();
  });

  it('marks an Outlook message removed, sets columns, and merges graphRemoved into existing metadata', async () => {
    const tx = fakeTx();
    tx.mailMessage.findUnique.mockResolvedValue({
      id: MESSAGE,
      threadId: THREAD,
      metadata: { folder: 'inbox' },
    });
    const removedAt = new Date('2026-07-27T12:00:00.000Z');

    const result = await markMailMessageRemovedInTx(asTx(tx), {
      tenantId: TENANT,
      source: EngagementSource.outlook,
      externalId: 'graph-1',
      reason: 'provider_removed',
      removedAt,
      providerMetadata: { graphRemoved: { reason: 'deleted' }, folder: 'inbox' },
    });

    expect(result).toEqual({ found: true, threadId: THREAD });
    const updateCall = tx.mailMessage.update.mock.calls[0]?.[0] as {
      data: { removedReason: string; metadata: Record<string, unknown> };
    };
    expect(updateCall.data.removedReason).toBe('provider_removed');
    expect(updateCall.data.metadata).toEqual({
      folder: 'inbox',
      graphRemoved: { reason: 'deleted' },
    });
    expect(tx.mailThread.update).toHaveBeenCalled();
  });

  it('is a no-op when no stored message matches the provider event', async () => {
    const tx = fakeTx();
    tx.mailMessage.findUnique.mockResolvedValue(null);

    const result = await markMailMessageRemovedInTx(asTx(tx), {
      tenantId: TENANT,
      source: EngagementSource.google,
      externalId: 'unknown-message',
      reason: 'deleted',
      removedAt: new Date(),
      providerMetadata: {},
    });

    expect(result).toEqual({ found: false, threadId: null });
    expect(tx.mailMessage.update).not.toHaveBeenCalled();
    expect(tx.mailThread.findUnique).not.toHaveBeenCalled();
    expect(tx.mailThread.update).not.toHaveBeenCalled();
  });

  it('replaces non-object metadata with an empty object before merging provider removal metadata', async () => {
    const tx = fakeTx();
    tx.mailMessage.findUnique.mockResolvedValue({
      id: MESSAGE,
      threadId: THREAD,
      metadata: 'not-an-object',
    });

    await markMailMessageRemovedInTx(asTx(tx), {
      tenantId: TENANT,
      source: EngagementSource.google,
      externalId: 'gmail-2',
      reason: 'spam',
      removedAt: new Date(),
      providerMetadata: { googleRemoved: { reason: 'spam' } },
    });

    const updateCall = tx.mailMessage.update.mock.calls[0]?.[0] as {
      data: { metadata: Record<string, unknown> };
    };
    expect(updateCall.data.metadata).toEqual({ googleRemoved: { reason: 'spam' } });
  });
});

describe('recomputeMailThreadSummaryInTx', () => {
  it('selects the latest active message ordered receivedAt/sentAt/createdAt and normalizes its body into the snippet', async () => {
    const tx = fakeTx();
    const receivedAt = new Date('2026-07-27T09:00:00.000Z');
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: '  Hello   world,\n\nthis is   the body.  ',
      subject: 'Re: Meeting notes',
      receivedAt,
      sentAt: null,
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
    });
    tx.mailThread.findUnique.mockResolvedValue({ metadata: { deleted: true, labels: ['INBOX'] } });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    expect(tx.mailMessage.findFirst).toHaveBeenCalledWith({
      where: { tenantId: TENANT, threadId: THREAD, removedAt: null },
      orderBy: [{ receivedAt: 'desc' }, { sentAt: 'desc' }, { createdAt: 'desc' }],
      select: { bodyText: true, subject: true, receivedAt: true, sentAt: true, createdAt: true },
    });

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data.snippet).toBe('Hello world, this is the body.');
    expect(updateCall.data.lastMessageAt).toBe(receivedAt);
    expect(updateCall.data.subject).toBe('Re: Meeting notes');
    expect(updateCall.data.metadata).toEqual({ deleted: false, labels: ['INBOX'] });
  });

  it('falls back to subject when the active message has no usable body', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: '   ',
      subject: 'No body here',
      receivedAt: null,
      sentAt: null,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
    });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data.snippet).toBe('No body here');
    expect(updateCall.data.lastMessageAt).toEqual(new Date('2026-07-20T00:00:00.000Z'));
  });

  it('caps the normalized snippet at 1000 characters', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: 'a'.repeat(2000),
      subject: 'Long email',
      receivedAt: new Date('2026-07-27T00:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect((updateCall.data.snippet as string).length).toBe(1000);
  });

  it('does not set subject when the active message subject is empty', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: 'body text',
      subject: '',
      receivedAt: new Date('2026-07-27T00:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
    });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data).not.toHaveProperty('subject');
  });

  it('clears snippet/lastMessageAt and marks the thread deleted when every message is removed (all-removed thread)', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue(null);
    tx.mailThread.findUnique.mockResolvedValue({ metadata: { labels: ['INBOX'] } });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data.snippet).toBeNull();
    expect(updateCall.data.lastMessageAt).toBeNull();
    expect(updateCall.data.metadata).toEqual({ labels: ['INBOX'], deleted: true });
  });

  it('restore: flips deleted back to false once an active message exists again, preserving other metadata keys', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: 'restored message body',
      subject: 'Restored',
      receivedAt: new Date('2026-07-27T00:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    tx.mailThread.findUnique.mockResolvedValue({ metadata: { deleted: true, labels: ['INBOX'] } });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    expect(updateCall.data.metadata).toEqual({ deleted: false, labels: ['INBOX'] });
  });

  it('never includes clientId or association fields in the update, leaving them untouched', async () => {
    const tx = fakeTx();
    tx.mailMessage.findFirst.mockResolvedValue({
      bodyText: 'body',
      subject: 'subject',
      receivedAt: new Date('2026-07-27T00:00:00.000Z'),
      sentAt: null,
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
    });
    tx.mailThread.findUnique.mockResolvedValue({ metadata: { manualAssociation: true } });

    await recomputeMailThreadSummaryInTx(asTx(tx), TENANT, THREAD);

    const updateCall = tx.mailThread.update.mock.calls[0]?.[0] as { data: Record<string, unknown> };
    for (const field of [
      'clientId',
      'associationScore',
      'associationReason',
      'associationSignals',
      'participants',
    ]) {
      expect(updateCall.data).not.toHaveProperty(field);
    }
    expect(updateCall.data.metadata).toEqual({ manualAssociation: true, deleted: false });
  });
});
