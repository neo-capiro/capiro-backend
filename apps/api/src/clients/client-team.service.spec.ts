import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClientTeamService } from './client-team.service.js';

/**
 * Client account teams. The behaviours worth pinning are the guards, because
 * each one prevents a roster that lies: a member from another tenant nobody in
 * the firm recognises, a silent owner-clearing, or an empty roster for a client
 * that isn't yours.
 */
describe('ClientTeamService', () => {
  const ctx = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    userId: '99999999-9999-4999-8999-999999999999',
    clerkUserId: 'user_synthetic',
    role: 'user_admin',
  } as never;
  const clientId = '22222222-2222-4222-8222-222222222222';
  const userId = '33333333-3333-4333-8333-333333333333';

  const makeService = () => {
    const tx = {
      tenantMembership: { findFirst: jest.fn(async () => ({ role: 'user_admin' })) },
      $queryRawUnsafe: jest.fn(async () => [{ allowed: true }]),
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(async () => 1),
    };
    const prisma = {
      withTenant: jest.fn(
        async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx),
      ),
    };
    return { service: new ClientTeamService(prisma as never), tx };
  };

  test('404s for a client outside the tenant instead of returning an empty roster', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw.mockResolvedValueOnce([]); // assertClient finds nothing

    await expect(service.list(ctx, clientId)).rejects.toBeInstanceOf(NotFoundException);
  });

  test('returns the merged roster with the owner flagged and dates serialized', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient
      .mockResolvedValueOnce([
        {
          id: null,
          userId: 'owner-1',
          email: 'neo@capiro.ai',
          firstName: 'Neo',
          lastName: 'Martinez',
          role: null,
          isOwner: true,
          addedAt: null,
        },
        {
          id: 'ctm-1',
          userId,
          email: 'lia@capiro.ai',
          firstName: 'Lia',
          lastName: 'Martinez',
          role: 'Lead lobbyist',
          isOwner: false,
          addedAt: new Date('2026-08-19T00:00:00.000Z'),
        },
      ]);

    await expect(service.list(ctx, clientId)).resolves.toEqual([
      {
        id: null,
        userId: 'owner-1',
        email: 'neo@capiro.ai',
        firstName: 'Neo',
        lastName: 'Martinez',
        role: null,
        isOwner: true,
        addedAt: null,
        ownerRank: null,
        ownerAvailable: null,
      },
      {
        id: 'ctm-1',
        userId,
        email: 'lia@capiro.ai',
        firstName: 'Lia',
        lastName: 'Martinez',
        role: 'Lead lobbyist',
        isOwner: false,
        addedAt: '2026-08-19T00:00:00.000Z',
        ownerRank: null,
        ownerAvailable: null,
      },
    ]);
  });

  test('refuses a user who is not an active member of this tenant', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient
      .mockResolvedValueOnce([]); // no active tenant membership

    await expect(service.add(ctx, clientId, userId, null)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  test('writes the membership for an active tenant member and re-reads the roster', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient (add)
      .mockResolvedValueOnce([{ id: 'membership-1' }]) // active member
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient (list)
      .mockResolvedValueOnce([]); // roster

    await expect(service.add(ctx, clientId, userId, 'Research')).resolves.toEqual([]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  test('will not remove the account owner through the roster endpoint', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]); // the user IS the account owner

    // Clearing the owner is `/api/client-account-owners/:clientId`, a separate
    // deliberate act — doing it as a side effect of a roster edit would surprise.
    await expect(service.remove(ctx, clientId, userId)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  test('removes an ordinary member', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient (remove)
      .mockResolvedValueOnce([]) // not the owner
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ role: 'user_admin' }])
      .mockResolvedValueOnce([]) // assertClient (list)
      .mockResolvedValueOnce([]); // roster

    await expect(service.remove(ctx, clientId, userId)).resolves.toEqual([]);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
