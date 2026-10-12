import { BadRequestException } from '@nestjs/common';
import { ClientAccountOwnerService } from './client-account-owner.service.js';
import { setup, ctx, client, ids } from './client-ordered-owner.test-support.js';

function fixture() {
  const f = setup();
  return { ...f, legacy: new ClientAccountOwnerService(f.prisma as never, f.service) };
}
describe('ClientAccountOwnerService compatibility', () => {
  test('lists only the rows returned by the active tenant-members query', async () => {
    const { legacy, tx } = fixture();
    const person = {
      id: ids[0],
      email: 'sarah@synthetic.invalid',
      firstName: 'Sarah',
      lastName: 'Martinez',
    };
    tx.$queryRaw.mockResolvedValueOnce([person] as never);
    await expect(legacy.listOptions(ctx)).resolves.toEqual([person]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  test('rejects an owner who is not an active member of the same tenant', async () => {
    const { legacy, state, tx } = fixture();
    state.members.delete(ids[0]);
    await expect(legacy.update(ctx, client, ids[0])).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  test('persists an active tenant member and returns the hydrated assignment', async () => {
    const { legacy, state } = fixture();
    const result = await legacy.update(ctx, client, ids[0]);
    expect(result).toEqual({
      accountOwnerUserId: ids[0],
      accountOwner: {
        id: ids[0],
        email: '0@synthetic.invalid',
        firstName: 'Person 0',
        lastName: null,
      },
    });
    expect(await legacy.get(ctx, client)).toEqual(result);
    expect(state).toMatchObject({ owners: [ids[0]], primary: ids[0], version: 1 });
  });
  test('batch projection excludes currently walled clients', async () => {
    const { legacy, tx } = fixture();
    tx.$queryRaw.mockResolvedValueOnce([
      { clientId: client, accountOwnerUserId: ids[0], id: ids[0], email: 'p@synthetic.invalid' },
    ] as never);
    tx.$queryRawUnsafe.mockResolvedValueOnce([{ id: client }] as never);
    expect(await legacy.listAll(ctx)).toEqual({});
  });
  test('options require current membership even with a stale role context', async () => {
    const { legacy, state, tx } = fixture();
    state.active = false;
    await expect(legacy.listOptions(ctx)).rejects.toMatchObject({ status: 403 });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
