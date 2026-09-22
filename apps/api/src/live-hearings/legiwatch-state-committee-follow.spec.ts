import type { TenantContext } from '@capiro/shared';
import { NotFoundException } from '@nestjs/common';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'tenant-a',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'clerk_user_a',
  role: 'standard_user',
};

describe('LegiWatch Florida committee follows', () => {
  function fixture(state = 'FL') {
    const findFirst = jest.fn(async () => null);
    const followed = {
      clientIds: [],
      notifyOnNewHearing: true,
      notifyOnScheduleChange: true,
      notifyOnTranscriptReady: false,
      notifyOnHighPriorityMatch: true,
      notifyOnPublication: true,
      createdAt: new Date('2026-09-22T12:00:00Z'),
      updatedAt: new Date('2026-09-22T12:00:00Z'),
    };
    const tx = {
      legiWatchCommitteeFollow: { findFirst, upsert: jest.fn(async () => followed) },
    };
    const initializeFollow = jest.fn(async () => 0);
    const prisma = {
      stateCommittee: {
        findUnique: jest.fn(async () => ({
          id: 'official-committee-1',
          state,
        })),
      },
      congressCommittee: { findFirst: jest.fn() },
      withTenant: jest.fn(async (tenantId: string, fn: (value: typeof tx) => unknown) => {
        expect(tenantId).toBe(ctx.tenantId);
        return fn(tx);
      }),
    };
    const service = new LegiWatchWave1Service(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      { initializeFollow } as never,
    );
    return { service, prisma, findFirst, tx, initializeFollow };
  }

  it('resolves a namespaced Florida id and reads the follow only in the caller tenant', async () => {
    const { service, prisma, findFirst } = fixture();
    const result = await service.committeeFollowState(ctx, 'state:fl:official-committee-1');

    expect(result).toMatchObject({
      committeeSystemCode: 'state:FL:official-committee-1',
      following: false,
    });
    expect(prisma.withTenant).toHaveBeenCalledWith(ctx.tenantId, expect.any(Function));
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        userId: ctx.userId,
        committeeSystemCode: 'state:FL:official-committee-1',
      },
    });
    expect(prisma.congressCommittee.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a state key whose jurisdiction does not match the canonical committee', async () => {
    const { service } = fixture('GA');
    await expect(
      service.committeeFollowState(ctx, 'state:FL:official-committee-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('stores the notification boundary in the same tenant transaction as follow creation', async () => {
    const { service, prisma, tx, initializeFollow } = fixture();
    const result = await service.upsertCommitteeFollow(ctx, 'state:FL:official-committee-1', {
      clientIds: [],
    });
    expect(result).toMatchObject({ following: true });
    expect(tx.legiWatchCommitteeFollow.upsert).toHaveBeenCalledTimes(1);
    expect(initializeFollow).toHaveBeenCalledWith(tx, {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      committeeSystemCode: 'state:FL:official-committee-1',
    });
    expect(prisma.withTenant).toHaveBeenCalledTimes(1);
  });
});
