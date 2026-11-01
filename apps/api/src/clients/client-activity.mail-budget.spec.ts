import { describe, expect, jest, test } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { Prisma } from '@prisma/client';
import { ClientActivityService, TIMELINE_MAIL_BUDGET_MS } from './client-activity.service.js';

/**
 * The synced-mail section of the client timeline runs after the timeline's
 * own transaction has released its connection, under a smaller server-side
 * budget, and degrades to an empty section when the database is busy.
 */
describe('ClientActivityService timeline mail section', () => {
  const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

  function setup() {
    const resolved = <T>(value: T) => jest.fn<() => Promise<T>>().mockResolvedValue(value);
    const tx = {
      $queryRawUnsafe: resolved([{ allowed: true }]),
      client: { findFirst: resolved({ id: 'client-1' }) },
      clientActivity: { findMany: resolved([]) },
      meeting: { findMany: resolved([]) },
      engagementAttachment: { findMany: resolved([]) },
      outreachRecord: { findMany: resolved([{ id: 'o1', title: 'Outreach', subject: null, createdAt: new Date('2026-10-01T00:00:00Z'), type: 'email', status: 'draft' }]) },
    };
    const open = { count: 0, duringMail: -1 };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, callback: (value: typeof tx) => unknown) => {
        open.count += 1;
        try { return await callback(tx); } finally { open.count -= 1; }
      }),
    };
    const engagement = { listMailThreads: jest.fn<() => Promise<unknown[]>>(), listAttachments: resolved([]) };
    engagement.listMailThreads.mockImplementation(async () => { open.duringMail = open.count; return []; });
    const service = new ClientActivityService(prisma as never, engagement as never);
    return { service, prisma, engagement, open };
  }

  test('reads mail with the timeline budget after the timeline transaction has closed', async () => {
    const { service, engagement, open } = setup();
    const items = await service.list(ctx, 'client-1');
    expect(engagement.listMailThreads).toHaveBeenCalledWith(ctx, { clientId: 'client-1' }, { budgetMs: TIMELINE_MAIL_BUDGET_MS });
    expect(engagement.listAttachments).toHaveBeenCalledWith(ctx, { clientId: 'client-1' });
    expect(TIMELINE_MAIL_BUDGET_MS).toBeLessThan(10_000);
    expect(open.duringMail).toBe(0);
    expect(items.map((item) => item.id)).toEqual(['outreach:o1']);
  });

  test.each([
    ['statement timeout', new Prisma.PrismaClientKnownRequestError('raw', { code: 'P2010', clientVersion: '5.22.0', meta: { code: '57014' } })],
    ['pool exhaustion', new Prisma.PrismaClientKnownRequestError('pool', { code: 'P2024', clientVersion: '5.22.0' })],
    ['transaction admission', new Prisma.PrismaClientKnownRequestError('tx', { code: 'P2028', clientVersion: '5.22.0' })],
  ])('degrades to an empty mail section on %s instead of failing the timeline', async (_label, failure) => {
    const { service, engagement } = setup();
    engagement.listMailThreads.mockRejectedValue(failure);
    const items = await service.list(ctx, 'client-1');
    expect(items.map((item) => item.id)).toEqual(['outreach:o1']);
  });

  test('still propagates access refusals from the mail read', async () => {
    const { service, engagement } = setup();
    engagement.listMailThreads.mockRejectedValue(new ForbiddenException('no mail scope'));
    await expect(service.list(ctx, 'client-1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
