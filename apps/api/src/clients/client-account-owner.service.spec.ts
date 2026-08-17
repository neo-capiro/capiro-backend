import { BadRequestException } from '@nestjs/common';
import { ClientAccountOwnerService } from './client-account-owner.service.js';

describe('ClientAccountOwnerService', () => {
  const ctx = { tenantId: '11111111-1111-1111-1111-111111111111', userId: 'user-1' } as never;
  const clientId = '22222222-2222-2222-2222-222222222222';
  const ownerId = '33333333-3333-3333-3333-333333333333';

  const makeService = () => {
    const tx = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(async () => 1),
    };
    const prisma = {
      withTenant: jest.fn(async (_tenantId: string, run: (tenantTx: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { service: new ClientAccountOwnerService(prisma as never), tx, prisma };
  };

  test('lists only the rows returned by the active tenant-members query', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw.mockResolvedValueOnce([
      { id: ownerId, email: 'sarah@example.com', firstName: 'Sarah', lastName: 'Martinez' },
    ]);

    await expect(service.listOptions(ctx)).resolves.toEqual([
      { id: ownerId, email: 'sarah@example.com', firstName: 'Sarah', lastName: 'Martinez' },
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  test('rejects an owner who is not an active member of the same tenant', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([]);

    await expect(service.update(ctx, clientId, ownerId)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  test('persists an active tenant member and returns the hydrated assignment', async () => {
    const { service, tx } = makeService();
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: clientId }])
      .mockResolvedValueOnce([{ id: 'membership-1' }])
      .mockResolvedValueOnce([
        {
          accountOwnerUserId: ownerId,
          id: ownerId,
          email: 'sarah@example.com',
          firstName: 'Sarah',
          lastName: 'Martinez',
        },
      ]);

    await expect(service.update(ctx, clientId, ownerId)).resolves.toEqual({
      accountOwnerUserId: ownerId,
      accountOwner: {
        id: ownerId,
        email: 'sarah@example.com',
        firstName: 'Sarah',
        lastName: 'Martinez',
      },
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
