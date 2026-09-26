import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
} as TenantContext;

function serviceWithTaskSpy() {
  const findMany = jest.fn().mockResolvedValue([]);
  const service = Object.create(EngagementService.prototype) as EngagementService;
  (service as unknown as { prisma: unknown }).prisma = {
    withTenant: async (_tenantId: string, fn: (tx: unknown) => unknown) =>
      fn({ engagementTask: { findMany } }),
  };
  return { service, findMany };
}

describe('EngagementService.listTasks wall and private-meeting boundary', () => {
  it('applies client grants and linked-meeting ownership in SQL before limit', async () => {
    const { service, findMany } = serviceWithTaskSpy();
    await service.listTasks(ctx, { limit: 5 });

    const query = findMany.mock.calls[0]?.[0];
    expect(query?.take).toBe(5);
    expect(query?.where?.tenantId).toBe(ctx.tenantId);
    expect(query?.where?.AND).toEqual([
      {
        OR: [
          {
            clientId: null,
            OR: [
              { createdByUserId: ctx.userId },
              { ownerUserId: ctx.userId },
            ],
          },
          {
            client: {
              is: {
                tenantId: ctx.tenantId,
                status: { not: 'archived' },
                OR: [
                  { memoryWall: false },
                  { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } },
                ],
              },
            },
          },
        ],
      },
      {
        OR: [
          { meetingId: null },
          {
            meeting: {
              is: {
                tenantId: ctx.tenantId,
                AND: [
                  {
                    OR: [
                      { createdByUserId: ctx.userId },
                      { connection: { createdByUserId: ctx.userId } },
                    ],
                    status: { not: 'deleted' },
                  },
                  {
                    OR: [
                      { clientId: null },
                      { client: { is: expect.objectContaining({ tenantId: ctx.tenantId }) } },
                    ],
                  },
                ],
              },
            },
          },
        ],
      },
      {
        OR: [
          { mailThreadId: null },
          {
            mailThread: {
              is: {
                tenantId: ctx.tenantId,
                connection: { createdByUserId: ctx.userId },
                messages: { some: { removedAt: null } },
                OR: [
                  { clientId: null },
                  { client: { is: expect.objectContaining({ tenantId: ctx.tenantId }) } },
                ],
              },
            },
          },
        ],
      },
      {
        OR: [
          { contactId: null },
          {
            contact: {
              is: {
                tenantId: ctx.tenantId,
                OR: [
                  { clientId: null },
                  { client: { is: expect.objectContaining({ tenantId: ctx.tenantId }) } },
                ],
              },
            },
          },
        ],
      },
    ]);
  });

  it('retains exact client and tenant filters alongside the wall predicate', async () => {
    const { service, findMany } = serviceWithTaskSpy();
    await service.listTasks(ctx, { clientId: '33333333-3333-4333-8333-333333333333' });
    expect(findMany.mock.calls[0]?.[0]?.where).toMatchObject({
      tenantId: ctx.tenantId,
      clientId: '33333333-3333-4333-8333-333333333333',
      AND: expect.any(Array),
    });
  });
});
