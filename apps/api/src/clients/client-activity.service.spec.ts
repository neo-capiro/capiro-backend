import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { ClientActivityService } from './client-activity.service.js';

describe('Manual activity occurrence dates', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
  function setup() {
    const tx = { client: { findFirst: jest.fn<() => Promise<unknown>>().mockResolvedValue({ id: 'client-1' }) },
      clientActivity: { create: jest.fn<(value: unknown) => Promise<unknown>>().mockImplementation(async (value) => value) } };
    const prisma = { withTenant: jest.fn(async (_tenant: string, callback: (tx: unknown) => unknown) => callback(tx)) };
    return { service: new ClientActivityService(prisma as never, {} as never), tx, prisma };
  }

  test('preserves a backfilled occurred-at timestamp without replacing creation time', async () => {
    const { service, tx } = setup();
    await service.create(ctx, 'client-1', { kind: 'call', title: 'Earlier call', occurredAt: '2025-01-15T10:30:00-05:00' });
    expect(tx.clientActivity.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      tenantId: 'tenant-1', clientId: 'client-1', occurredAt: new Date('2025-01-15T15:30:00Z'),
    }) });
    expect((tx.clientActivity.create.mock.calls[0]![0] as { data: object }).data).not.toHaveProperty('createdAt');
  });

  test.each(['not-a-date', '2025-02-30T00:00:00Z', '2099-01-01T00:00:00Z'])('rejects invalid or future activity dates: %s', async (occurredAt) => {
    const { service, prisma } = setup();
    await expect(service.create(ctx, 'client-1', { kind: 'note', title: 'Note', occurredAt })).rejects.toThrow();
    expect(prisma.withTenant).not.toHaveBeenCalled();
  });
});

describe('ClientActivityService email history', () => {
  test('includes client-associated synced mail threads in relationship history', async () => {
    const tx = {
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
    const engagement = { listMailThreads: jest.fn() };
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
      withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx)),
    };
    const service = new ClientActivityService(prisma as never, engagement as never);
    const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

    const result = await service.list(ctx, 'client-1');

    expect(engagement.listMailThreads).toHaveBeenCalledWith(ctx, { clientId: 'client-1' });
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
