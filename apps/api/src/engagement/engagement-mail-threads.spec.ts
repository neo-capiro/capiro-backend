// Phase d4 (remaining-items plan §3.d4) — listMailThreads must exclude
// removed messages from both the thread-ownership predicate (inherited from
// ownMailThreadWhere after Phase a's activeMailThreadWhere() spread) and the
// nested messages slice.

import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';

const ctx: TenantContext = {
  tenantId: TENANT,
  tenantSlug: 'acme',
  userId: USER,
  clerkUserId: 'clerk-1',
  role: 'user' as TenantContext['role'],
};

function makeService() {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  const findMany = jest.fn<(...args: unknown[]) => Promise<unknown[]>>().mockResolvedValue([]);
  patch.prisma = {
    withTenant: (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ mailThread: { findMany } }),
  };
  return { service, findMany };
}

describe('EngagementService.listMailThreads', () => {
  test('the thread query is connection-owner scoped and active-only', async () => {
    const { service, findMany } = makeService();

    await service.listMailThreads(ctx, {});

    const call = findMany.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).toEqual({
      tenantId: TENANT,
      connection: { createdByUserId: USER },
      messages: { some: { removedAt: null } },
    });
  });

  test('nested messages are filtered active-only, ordered receivedAt/sentAt/createdAt desc, capped at 3', async () => {
    const { service, findMany } = makeService();

    await service.listMailThreads(ctx, {});

    const call = findMany.mock.calls[0]?.[0] as {
      include: { messages: { where: unknown; orderBy: unknown; take: number } };
    };
    expect(call.include.messages.where).toEqual({ removedAt: null });
    expect(call.include.messages.orderBy).toEqual([
      { receivedAt: 'desc' },
      { sentAt: 'desc' },
      { createdAt: 'desc' },
    ]);
    expect(call.include.messages.take).toBe(3);
  });

  test('a different user does not inherit ownership (connection-owner scoping is per-user)', async () => {
    const { service, findMany } = makeService();
    const otherUser = '33333333-3333-3333-3333-333333333333';

    await service.listMailThreads({ ...ctx, userId: otherUser }, {});

    const call = findMany.mock.calls[0]?.[0] as { where: { connection: { createdByUserId: string } } };
    expect(call.where.connection.createdByUserId).toBe(otherUser);
  });
});
