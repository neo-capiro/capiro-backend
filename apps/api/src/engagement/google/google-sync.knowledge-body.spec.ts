import { describe, expect, test } from '@jest/globals';
import { GoogleSyncService } from './google-sync.service.js';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function setup() {
  const upsert = jest.fn().mockResolvedValue({ id: 'mail-1' });
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    mailMessage: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert,
    },
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'thread-1' }),
      update: jest.fn().mockResolvedValue({ id: 'thread-1' }),
    },
    engagementContact: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    clientAssociationOverride: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const prisma = {
    withTenantRetry: jest.fn((_tenantId: string, fn: (t: unknown) => unknown) => fn(tx)),
  };
  const association = {
    associate: jest.fn(async () => ({
      clientId: 'client-1',
      score: 0.9,
      reason: 'match',
      signals: {},
    })),
  };
  const service = new GoogleSyncService(prisma as never, association as never, {} as never);
  return { service, upsert };
}

const FULL_BODY =
  'Please protect PE 0605053A and avoid leading with autonomy in our committee outreach.';

type Persist = (
  tenantId: string,
  connectionId: string,
  message: unknown,
  syncMode: 'incremental' | 'backfill',
) => Promise<string>;

describe('GoogleSyncService persistGmailMessage — Knowledge Plane body', () => {
  test('stamps MIME-derived full bodies with bodyCompleteness full', async () => {
    const { service, upsert } = setup();
    const outcome = await (service as unknown as { persistGmailMessage: Persist }).persistGmailMessage(
      'tenant-1',
      'conn-1',
      {
        id: 'gmail-1',
        threadId: 'thread-ext-1',
        snippet: 'Please protect PE 0605053A…',
        labelIds: ['INBOX'],
        internalDate: String(Date.parse('2026-08-14T13:00:00Z')),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Jane <jane@example.com>' },
            { name: 'To', value: 'Neo <neo@capiro.ai>' },
            { name: 'Subject', value: 'FY28 Ground Robotics strategy' },
            { name: 'Message-ID', value: '<gmail-1@example.com>' },
          ],
          parts: [{ mimeType: 'text/plain', body: { data: b64url(FULL_BODY) } }],
        },
      },
      'incremental',
    );

    expect(outcome).toBe('matched');
    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { bodyText: string | null; metadata: Record<string, unknown> };
      update: { metadata: Record<string, unknown> };
    };
    expect(upserted.create.bodyText).toBe(FULL_BODY);
    expect(upserted.create.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'full', mailboxSyncMode: 'incremental' }),
    );
    expect(upserted.update.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'full', mailboxSyncMode: 'incremental' }),
    );
  });

  test('does not treat a Gmail snippet fallback as a full authoritative body', async () => {
    const { service, upsert } = setup();
    await (service as unknown as { persistGmailMessage: Persist }).persistGmailMessage(
      'tenant-1',
      'conn-1',
      {
        id: 'gmail-preview',
        threadId: 'thread-ext-1',
        snippet: 'This is only a provider snippet and not the complete authoritative body.',
        labelIds: ['INBOX'],
        internalDate: String(Date.parse('2026-08-14T13:00:00Z')),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Jane <jane@example.com>' },
            { name: 'To', value: 'Neo <neo@capiro.ai>' },
            { name: 'Subject', value: 'Snippet only' },
          ],
        },
      },
      'incremental',
    );

    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { bodyText: string | null; metadata: Record<string, unknown> };
    };
    expect(upserted.create.bodyText).toBe(
      'This is only a provider snippet and not the complete authoritative body.',
    );
    expect(upserted.create.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'preview', mailboxSyncMode: 'incremental' }),
    );
  });

  test('oversized MIME bodies are truncated and never stamped full', async () => {
    const { service, upsert } = setup();
    const huge = 'A'.repeat(100_001);
    await (service as unknown as { persistGmailMessage: Persist }).persistGmailMessage(
      'tenant-1',
      'conn-1',
      {
        id: 'gmail-huge',
        threadId: 'thread-ext-1',
        snippet: 'oversized',
        labelIds: ['INBOX'],
        internalDate: String(Date.parse('2026-08-14T13:00:00Z')),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Jane <jane@example.com>' },
            { name: 'To', value: 'Neo <neo@capiro.ai>' },
            { name: 'Subject', value: 'Huge body' },
          ],
          parts: [{ mimeType: 'text/plain', body: { data: b64url(huge) } }],
        },
      },
      'incremental',
    );

    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { bodyText: string | null; metadata: Record<string, unknown> };
    };
    expect(upserted.create.bodyText?.endsWith('\n\n[truncated]')).toBe(true);
    expect(upserted.create.bodyText?.length).toBe(100_000 + '\n\n[truncated]'.length);
    expect(upserted.create.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'truncated', mailboxSyncMode: 'incremental' }),
    );
    expect(upserted.create.metadata.bodyCompleteness).not.toBe('full');
  });

  test('stamps explicit backfill mode without inventing incremental', async () => {
    const { service, upsert } = setup();
    await (service as unknown as { persistGmailMessage: Persist }).persistGmailMessage(
      'tenant-1',
      'conn-1',
      {
        id: 'gmail-backfill',
        threadId: 'thread-ext-1',
        snippet: 'bf',
        labelIds: ['INBOX'],
        internalDate: String(Date.parse('2026-08-14T13:00:00Z')),
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Jane <jane@example.com>' },
            { name: 'To', value: 'Neo <neo@capiro.ai>' },
            { name: 'Subject', value: 'Backfill' },
          ],
          parts: [{ mimeType: 'text/plain', body: { data: b64url(FULL_BODY) } }],
        },
      },
      'backfill',
    );

    const upserted = upsert.mock.calls[0]?.[0] as {
      create: { metadata: Record<string, unknown> };
    };
    expect(upserted.create.metadata).toEqual(
      expect.objectContaining({ bodyCompleteness: 'full', mailboxSyncMode: 'backfill' }),
    );
  });
});
