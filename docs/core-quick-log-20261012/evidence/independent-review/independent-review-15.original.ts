import { ClientActivityService } from '../client-activity.service.js';
import { bearer, basicInput, ctx, fixture, followInput, IDs } from '../../../test/support/activity-command.fixture.js';

const secondClient = '30000000-0000-4000-8000-000000000002';
const secondTask = '70000000-0000-4000-8000-000000000002';

describe('independent Quick log recovery and authorization review', () => {
  it.each(['assigneeActive', 'assigneeWall'] as const)(
    'recovers completed visibility after temporary %s revocation during remote acceptance',
    async (field) => {
      const f = fixture();
      f.planner.create.mockImplementationOnce(async (_ctx, _bearer, key) => {
        f.remote.set(key, IDs.task);
        f.state[field] = false;
        return { kind: 'found', taskId: IDs.task };
      });
      const held = await f.service.create(ctx, IDs.client, followInput, bearer);
      expect(held).toMatchObject({ status: 'needs_attention', reason: 'assignee_unavailable', followUp: { taskId: null } });
      expect(f.rows[0]).toMatchObject({ status: 'completed', taskId: IDs.task });
      f.state[field] = true;
      const restored = await f.service.get(ctx, IDs.client, IDs.request, bearer);
      expect(restored).toMatchObject({ status: 'completed', reason: null, followUp: { state: 'completed', taskId: IDs.task } });
      expect(f.planner.create).toHaveBeenCalledTimes(1);
    },
  );

  it('survives a lost Core commit response without duplicating activity', async () => {
    const f = fixture();
    const original = f.prisma.withTenant.getMockImplementation()!;
    f.prisma.withTenant.mockImplementationOnce(async (tenant, callback) => {
      await original(tenant, callback);
      throw Error('Lost Core response after commit');
    });
    await expect(f.service.create(ctx, IDs.client, basicInput, bearer)).rejects.toThrow('Lost Core response');
    expect(f.rows).toHaveLength(1);
    const restored = await f.service.create(ctx, IDs.client, basicInput, bearer);
    expect(restored.status).toBe('completed');
    expect(f.activities).toHaveLength(1);
    expect(f.rows).toHaveLength(1);
    expect(f.planner.lookup).not.toHaveBeenCalled();
  });

  it('keeps same browser request UUID independent across clients and remote keys', async () => {
    const f = fixture();
    f.tx.client.findFirst.mockImplementation(async ({ where }: any) =>
      where.tenantId === IDs.tenant && [IDs.client, secondClient].includes(where.id) ? { id: where.id } : null,
    );
    const input = { ...followInput, activity: { kind: 'note', title: 'Generic review' } };
    const a = await f.service.create(ctx, IDs.client, input, bearer);
    const b = await f.service.create(ctx, secondClient, input, bearer);
    expect(a.commandId).not.toBe(b.commandId);
    expect(f.rows).toHaveLength(2);
    expect(f.activities).toHaveLength(2);
    expect(f.planner.create.mock.calls.map(call => call[2])).toEqual([a.commandId, b.commandId]);
  });

  it('fences late old completion after another attempt owns and completes the command', async () => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    f.planner.lookup.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return { kind: 'found', taskId: secondTask };
    });
    const old = f.service.create(ctx, IDs.client, followInput, bearer);
    await ready;
    f.rows[0].leaseUntil = new Date(0);
    const fresh = await f.service.resume(ctx, IDs.client, IDs.request, { expectedVersion: f.rows[0].version }, bearer);
    expect(fresh.followUp?.taskId).toBe(IDs.task);
    const saved = structuredClone(f.rows[0]);
    release();
    const late = await old;
    expect(f.rows[0]).toEqual(saved);
    expect(late.followUp?.taskId).not.toBe(secondTask);
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    expect(f.activities).toHaveLength(1);
  });

  it('withholds a cached task destination when remote recovery returns a different task ID', async () => {
    const f = fixture();
    await f.service.create(ctx, IDs.client, followInput, bearer);
    f.planner.lookup.mockResolvedValueOnce({ kind: 'found', taskId: secondTask });
    const receipt = await f.service.get(ctx, IDs.client, IDs.request, bearer);
    expect(receipt).toMatchObject({ status: 'needs_attention', followUp: { taskId: null, state: 'unavailable' } });
    expect(f.rows[0].taskId).toBe(IDs.task);
  });

  it('rechecks actor authority after a read-only remote lookup', async () => {
    const f = fixture();
    await f.service.create(ctx, IDs.client, followInput, bearer);
    f.planner.lookup.mockImplementationOnce(async () => {
      f.state.actorWall = false;
      return { kind: 'found', taskId: IDs.task };
    });
    await expect(f.service.get(ctx, IDs.client, IDs.request, bearer)).rejects.toThrow('not found');
    expect(f.planner.create).toHaveBeenCalledTimes(1);
  });

  it('does not POST after contact association changes while read-only remote lookup is pending', async () => {
    const f = fixture();
    f.planner.lookup.mockImplementationOnce(async () => {
      f.activities[0].personId = null;
      return { kind: 'missing' };
    });
    const receipt = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(receipt).toMatchObject({ reason: 'person_unavailable', followUp: { taskId: null } });
    expect(f.planner.create).not.toHaveBeenCalled();
    expect(f.rows).toHaveLength(1);
  });
});

function legacyFixture() {
  const f = fixture();
  const tx = f.tx as any;
  tx.clientActivity.findMany = jest.fn(async () => [...f.activities]);
  tx.clientActivity.update = jest.fn(async ({ where, data }: any) => {
    const row = f.activities.find(activity => activity.id === where.id);
    Object.assign(row, data);
    return row;
  });
  tx.clientActivity.deleteMany = jest.fn(async ({ where }: any) => {
    const index = f.activities.findIndex(activity => activity.id === where.id && activity.clientId === where.clientId && activity.tenantId === where.tenantId);
    if (index < 0) return { count: 0 };
    f.activities.splice(index, 1);
    return { count: 1 };
  });
  tx.meeting = { findMany: jest.fn(async () => []) };
  tx.engagementAttachment = { findMany: jest.fn(async () => []) };
  tx.outreachRecord = { findMany: jest.fn(async () => []) };
  const legacy = new ClientActivityService(f.prisma as any, { listMailThreads: jest.fn(async () => []) } as any);
  return { ...f, legacy };
}

describe('independent canonical activity ethical-wall review', () => {
  it('denies legacy timeline access after the command creator loses the client wall', async () => {
    const f = legacyFixture();
    await f.service.create(ctx, IDs.client, basicInput, bearer);
    f.state.actorWall = false;
    await expect(f.legacy.list(ctx, IDs.client)).rejects.toThrow('not found');
    expect((f.tx.clientActivity as any).findMany).not.toHaveBeenCalled();
  });
  it('denies legacy create after the client wall is revoked', async () => {
    const f = legacyFixture();
    f.state.actorWall = false;
    await expect(f.legacy.create(ctx, IDs.client, { kind: 'note', title: 'Forbidden' })).rejects.toThrow('not found');
    expect(f.activities).toHaveLength(0);
  });
  it('denies legacy editing of protected activity after the client wall is revoked', async () => {
    const f = legacyFixture();
    await f.service.create(ctx, IDs.client, basicInput, bearer);
    f.state.actorWall = false;
    await expect(f.legacy.update(ctx, IDs.client, IDs.activity, { title: 'Changed without permission' })).rejects.toThrow('not found');
    expect(f.activities[0].title).toBe(basicInput.activity.title);
  });
  it('denies legacy deletion after the client wall is revoked', async () => {
    const f = legacyFixture();
    await f.service.create(ctx, IDs.client, basicInput, bearer);
    f.state.actorWall = false;
    await expect(f.legacy.remove(ctx, IDs.client, IDs.activity)).rejects.toThrow('not found');
    expect(f.activities).toHaveLength(1);
  });
  it('preserves authorized legacy deletion and the command tombstone without recreation', async () => {
    const f = legacyFixture();
    await f.service.create(ctx, IDs.client, basicInput, bearer);
    await expect(f.legacy.remove(ctx, IDs.client, IDs.activity)).resolves.toEqual({ ok: true });
    const replay = await f.service.create(ctx, IDs.client, basicInput, bearer);
    expect(replay).toMatchObject({ reason: 'activity_removed', activity: { available: false } });
    expect(f.rows).toHaveLength(1);
    expect(f.activities).toHaveLength(0);
  });
});

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
    const denied = await f.service.resume(ctx, IDs.client, IDs.request, { expectedVersion: first.version }, bearer);
    expect(denied).toMatchObject({ reason: 'planner_access_denied', followUp: { taskId: null } });
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    // Canonical PR2395 preserves its receipt when the task is deleted: GET and
    // identical-key POST return unavailable rather than creating another task.
    f.remote.clear();
    f.planner.create.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_rejected' });
    const deleted = await f.service.resume(ctx, IDs.client, IDs.request, { expectedVersion: denied.version }, bearer);
    expect(deleted).toMatchObject({ status: 'needs_attention', followUp: { taskId: null } });
    expect(f.planner.create.mock.calls.map(call => call[2])).toEqual([key, key]);
    expect(f.rows[0].id).toBe(key);
    expect(f.activities).toHaveLength(1);
  });

  it('never performs remote receipt reads or writes while a Core transaction is open', async () => {
    const f = fixture();
    const original = f.prisma.withTenant.getMockImplementation()!;
    let activeTransactions = 0;
    f.prisma.withTenant.mockImplementation(async (tenant, callback) => original(tenant, async tx => {
      activeTransactions++;
      try { return await callback(tx); } finally { activeTransactions--; }
    }));
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
