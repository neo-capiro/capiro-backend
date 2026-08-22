import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { ClientActivityService } from './client-activity.service.js';

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
