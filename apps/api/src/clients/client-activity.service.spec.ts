import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
// These unit tests inject the canonical reader; no unrelated Engagement provider graph is needed.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
import { ClientActivityService } from './client-activity.service.js';

describe('Manual activity occurrence dates', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
  function setup() {
    const tx = {
      $queryRawUnsafe: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ allowed: true }]),
      client: {
        findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 'client-1' }),
      },
      clientActivity: {
        create: jest
          .fn<(value: unknown) => Promise<unknown>>()
          .mockImplementation(async (value) => value),
      },
    };
    const prisma = {
      withTenant: jest.fn(async (_tenant: string, callback: (tx: unknown) => unknown) =>
        callback(tx),
      ),
    };
    return { service: new ClientActivityService(prisma as never, {} as never), tx, prisma };
  }

  test('preserves a backfilled occurred-at timestamp without replacing creation time', async () => {
    const { service, tx } = setup();
    await service.create(ctx, 'client-1', {
      kind: 'call',
      title: 'Earlier call',
      occurredAt: '2025-01-15T10:30:00-05:00',
    });
    expect(tx.clientActivity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant-1',
        clientId: 'client-1',
        occurredAt: new Date('2025-01-15T15:30:00Z'),
      }),
    });
    expect(
      (tx.clientActivity.create.mock.calls[0]![0] as { data: object }).data,
    ).not.toHaveProperty('createdAt');
  });

  test.each(['not-a-date', '2025-02-30T00:00:00Z', '2099-01-01T00:00:00Z'])(
    'rejects invalid or future activity dates: %s',
    async (occurredAt) => {
      const { service, prisma } = setup();
      await expect(
        service.create(ctx, 'client-1', { kind: 'note', title: 'Note', occurredAt }),
      ).rejects.toThrow();
      expect(prisma.withTenant).not.toHaveBeenCalled();
    },
  );
});

describe('ClientActivityService email history', () => {
  test('includes client-associated synced mail threads in relationship history', async () => {
    const tx = {
      $queryRawUnsafe: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ allowed: true }]),
      client: { findFirst: jest.fn() },
      clientActivity: { findMany: jest.fn() },
      meeting: { findMany: jest.fn() },
      engagementAttachment: { findMany: jest.fn() },
      outreachRecord: { findMany: jest.fn() },
    };
    const mock = (fn: unknown) => fn as { mockResolvedValue: (value: unknown) => void };
    mock(tx.client.findFirst).mockResolvedValue({ id: 'client-1' });
    mock(tx.clientActivity.findMany).mockResolvedValue([]);
    mock(tx.meeting.findMany).mockResolvedValue([]);
    mock(tx.engagementAttachment.findMany).mockResolvedValue([]);
    mock(tx.outreachRecord.findMany).mockResolvedValue([]);
    const engagement = {
      listMailThreads: jest.fn(),
      listAttachments: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    };
    mock(engagement.listMailThreads).mockResolvedValue([
      {
        id: 'mail-1',
        subject: 'FY27 robotics update',
        snippet: 'The client asked for the revised narrative.',
        lastMessageAt: new Date('2026-08-20T15:00:00.000Z'),
        createdAt: new Date('2026-08-18T15:00:00.000Z'),
      },
    ]);
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) =>
        callback(tx),
      ),
    };
    const service = new ClientActivityService(prisma as never, engagement as never);
    const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

    const result = await service.list(ctx, 'client-1');

    // The timeline reads mail after its own transaction, under its bounded budget.
    expect(engagement.listMailThreads).toHaveBeenCalledWith(ctx, { clientId: 'client-1' }, { budgetMs: 5_000 });
    expect(result).toEqual([
      expect.objectContaining({
        id: 'email:mail-1',
        kind: 'email',
        title: 'FY27 robotics update',
        body: 'The client asked for the revised narrative.',
        sourceType: 'mail_thread',
        sourceId: 'mail-1',
        origin: 'derived',
      }),
    ]);
  });
});

describe('Client activity authorized attachment projection', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
  const document = (n: number) => ({
    id: `file-${n}`,
    fileName: `Document ${n}`,
    source: 'upload',
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n)),
    s3Key: 'private-storage-key',
    downloadUrl: 'private-signed-url',
    previewUrl: 'private-preview-url',
    viewerUserIds: ['private-viewer'],
  });
  function setup(rows: ReturnType<typeof document>[]) {
    const tx = {
      $queryRawUnsafe: jest.fn<() => Promise<unknown>>().mockResolvedValue([{ allowed: true }]),
      client: {
        findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 'client-1' }),
      },
      clientActivity: { findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
      meeting: { findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
      outreachRecord: { findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
      engagementAttachment: { findMany: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]) },
    };
    const engagement = {
      listAttachments: jest
        .fn<() => Promise<ReturnType<typeof document>[]>>()
        .mockResolvedValue(rows),
      listMailThreads: jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    };
    const prisma = { withTenant: async (_: string, run: (tx: unknown) => unknown) => run(tx) };
    return {
      tx,
      engagement,
      service: new ClientActivityService(prisma as never, engagement as never),
    };
  }
  test('keeps global chronological ordering and returns only ActivityItem metadata', async () => {
    const f = setup([document(4), document(2), document(1)]);
    f.engagement.listMailThreads.mockResolvedValue([
      {
        id: 'mail',
        subject: 'Message',
        snippet: null,
        createdAt: document(3).createdAt,
        lastMessageAt: null,
      },
    ]);
    const result = await f.service.list(ctx, 'client-1', { limit: 3 });
    expect(result.map((r) => r.id)).toEqual(['document:file-4', 'email:mail', 'document:file-2']);
    expect(result[0]).toEqual({
      id: 'document:file-4',
      kind: 'document',
      occurredAt: document(4).createdAt.toISOString(),
      title: 'Document 4',
      body: 'upload',
      personId: null,
      sourceType: 'attachment',
      sourceId: 'file-4',
      pinned: false,
      dueAt: null,
      settledAt: null,
      origin: 'derived',
    });
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(f.engagement.listAttachments).toHaveBeenCalledWith(ctx, { clientId: 'client-1' });
    expect(f.tx.engagementAttachment.findMany).not.toHaveBeenCalled();
  });
  test.each<[number | undefined, number]>([
    [undefined, 200],
    [Number.NaN, 200],
    [999, 500],
    [0, 1],
  ])('preserves the existing limit %s after authorization (%s rows)', async (limit, expected) => {
    const f = setup(Array.from({ length: 550 }, (_, n) => document(550 - n)));
    const result = await f.service.list(ctx, 'client-1', { kinds: ['document'], limit });
    expect(result).toHaveLength(expected);
    expect(result[0]?.sourceId).toBe('file-550');
    expect(result.at(-1)?.sourceId).toBe(`file-${551 - expected}`);
  });
  test('keeps the kind filter and propagates canonical failures instead of inventing an empty list', async () => {
    const f = setup([document(1)]);
    expect(await f.service.list(ctx, 'client-1', { kinds: ['meeting'] })).toEqual([]);
    const failure = new Error('synthetic attachment read unavailable');
    f.engagement.listAttachments.mockRejectedValue(failure);
    await expect(f.service.list(ctx, 'client-1')).rejects.toBe(failure);
  });
});
