import {
  bearer,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../../test/support/activity-command.fixture.js';

describe('independent ambiguous remote outcome review', () => {
  it('does not send after inaccessible receipt recovery, then reuses only the tombstoned key', async () => {
    const f = fixture();
    f.planner.create.mockImplementationOnce(async (_ctx, _bearer, key) => {
      f.remote.set(key, IDs.task);
      return { kind: 'blocked', code: 'planner_unavailable' };
    });
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    const key = first.commandId;
    f.planner.lookup.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_access_denied' });
    const denied = await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: first.version },
      bearer,
    );
    expect(denied).toMatchObject({ reason: 'planner_access_denied', followUp: { taskId: null } });
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    // Canonical PR2395 preserves its receipt when the task is deleted: GET and
    // identical-key POST return unavailable rather than creating another task.
    f.remote.clear();
    f.planner.create.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_rejected' });
    const deleted = await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: denied.version },
      bearer,
    );
    expect(deleted).toMatchObject({ status: 'needs_attention', followUp: { taskId: null } });
    expect(f.planner.create.mock.calls.map((call) => call[2])).toEqual([key, key]);
    expect(f.rows[0].id).toBe(key);
    expect(f.activities).toHaveLength(1);
  });

  it('never performs remote receipt reads or writes while a Core transaction is open', async () => {
    const f = fixture();
    const original = f.prisma.withTenant.getMockImplementation()!;
    let activeTransactions = 0;
    f.prisma.withTenant.mockImplementation(async (tenant, callback) =>
      original(tenant, async (tx) => {
        activeTransactions++;
        try {
          return await callback(tx);
        } finally {
          activeTransactions--;
        }
      }),
    );
    f.planner.lookup.mockImplementation(async (_ctx, _bearer, key) => {
      expect(activeTransactions).toBe(0);
      return f.remote.has(key) ? { kind: 'found', taskId: f.remote.get(key) } : { kind: 'missing' };
    });
    f.planner.create.mockImplementation(async (_ctx, _bearer, key) => {
      expect(activeTransactions).toBe(0);
      f.remote.set(key, IDs.task);
      return { kind: 'found', taskId: IDs.task };
    });
    await f.service.create(ctx, IDs.client, followInput, bearer);
    await f.service.get(ctx, IDs.client, IDs.request, bearer);
    expect(f.planner.create).toHaveBeenCalledTimes(1);
  });
});
