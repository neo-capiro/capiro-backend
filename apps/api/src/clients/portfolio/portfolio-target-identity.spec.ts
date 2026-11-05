import { BadRequestException, ConflictException } from '@nestjs/common';
import { ClientTargetsService } from '../client-targets.service.js';
const ctx = { tenantId: 'fixture-tenant', userId: 'fixture-user' } as never;
describe('office relationship canonical identity', () => {
  it('keys same-member parents independently by directory and term', async () => {
    const rows = new Map<string, unknown>();
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'fixture-client' }) },
      clientTarget: {
        findFirst: jest.fn(
          async ({ where }) =>
            rows.get(`${where.sourceDirectory}:${where.memberId}:${where.officeTerm}`) ?? null,
        ),
        upsert: jest.fn(async ({ where, create }) => {
          const key = where.clientId_sourceDirectory_memberId_officeTerm;
          const id = `${key.sourceDirectory}:${key.memberId}:${key.officeTerm}`;
          const row = { id, ...create };
          rows.set(id, row);
          return row;
        }),
      },
    };
    const service = new ClientTargetsService(
      {} as never,
      { getAllContacts: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
    );
    const snapshot = {
      memberName: null,
      party: null,
      state: null,
      chamber: null,
      committee: null,
      staffKind: null,
    };
    const first = await service.addTargetInTransaction(
      tx as never,
      ctx,
      'fixture-client',
      { memberId: 'fixture-office', sourceDirectory: 'congress', officeTerm: 'congress:119' },
      snapshot,
    );
    const second = await service.addTargetInTransaction(
      tx as never,
      ctx,
      'fixture-client',
      { memberId: 'fixture-office', sourceDirectory: 'congress', officeTerm: 'congress:120' },
      snapshot,
    );
    const third = await service.addTargetInTransaction(
      tx as never,
      ctx,
      'fixture-client',
      { memberId: 'fixture-office', sourceDirectory: 'state', officeTerm: 'congress:119' },
      snapshot,
    );
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    await expect(
      service.addTargetInTransaction(
        tx as never,
        ctx,
        'fixture-client',
        { memberId: 'fixture-office', sourceDirectory: 'congress', officeTerm: 'congress:119' },
        snapshot,
      ),
    ).resolves.toEqual(first);
    expect(tx.clientTarget.upsert).toHaveBeenCalledTimes(3);
  });
  it.each(['119', '119th Congress', 'Congress:119'])(
    'rejects alias %s before a parent can be created',
    async (officeTerm) => {
      const tx = {
        client: { findFirst: jest.fn().mockResolvedValue({ id: 'fixture-client' }) },
        clientTarget: { findFirst: jest.fn(), upsert: jest.fn() },
      };
      const service = new ClientTargetsService({} as never, {} as never, {} as never);
      const snapshot = {
        memberName: null,
        party: null,
        state: null,
        chamber: null,
        committee: null,
        staffKind: null,
      };
      await expect(
        service.addTargetInTransaction(
          tx as never,
          ctx,
          'fixture-client',
          { memberId: 'fixture-office', sourceDirectory: 'congress', officeTerm },
          snapshot,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.clientTarget.upsert).not.toHaveBeenCalled();
    },
  );
  it('never silently deletes one of several directory/term matches', async () => {
    const tx = {
      client: { findFirst: jest.fn().mockResolvedValue({ id: 'fixture-client' }) },
      clientTarget: {
        findMany: jest.fn().mockResolvedValue([{ id: 'one' }, { id: 'two' }]),
        delete: jest.fn(),
      },
    };
    const service = new ClientTargetsService(
      { withTenant: jest.fn(async (_tenant, work) => work(tx)) } as never,
      {} as never,
      {} as never,
    );
    await expect(
      service.removeTarget(ctx, 'fixture-client', 'fixture-office'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.clientTarget.delete).not.toHaveBeenCalled();
  });
});
