import {
  bearer,
  basicInput,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../../test/support/activity-command.fixture.js';

describe('durable Core activity commands', () => {
  it('commits activity and receipt together; replay preserves lineage without rewriting an edited activity', async () => {
    const f = fixture();
    const first = await f.service.create(ctx, IDs.client, basicInput, bearer);
    f.activities[0].title = 'Edited later';
    const replay = await f.service.create(ctx, IDs.client, basicInput, bearer);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: 'completed',
      version: 0,
      clientId: IDs.client,
      actorUserId: IDs.actor,
      activity: { id: IDs.activity, personId: IDs.person },
      followUp: null,
    });
    expect(f.activities).toHaveLength(1);
    expect(f.activities[0]).toMatchObject({
      title: 'Edited later',
      sourceType: 'activity_command',
      sourceId: first.commandId,
    });
    expect(f.planner.create).not.toHaveBeenCalled();
  });
  it('rolls back the canonical activity when command persistence fails', async () => {
    const f = fixture();
    f.state.failCommandInsert = true;
    await expect(f.service.create(ctx, IDs.client, basicInput, bearer)).rejects.toThrow(
      'Synthetic insert',
    );
    expect(f.activities).toHaveLength(0);
    expect(f.rows).toHaveLength(0);
  });
  it('does not repeat a future-dated or invalid-contact activity', async () => {
    const f = fixture();
    await expect(
      f.service.create(
        ctx,
        IDs.client,
        { ...basicInput, activity: { ...basicInput.activity, occurredAt: '2999-01-01T00:00:00Z' } },
        bearer,
      ),
    ).rejects.toThrow('already occurred');
    f.state.personActive = false;
    await expect(f.service.create(ctx, IDs.client, basicInput, bearer)).rejects.toThrow(
      'not a contact',
    );
    expect(f.rows).toHaveLength(0);
  });
  it('rejects changed payload with the same key', async () => {
    const f = fixture();
    await f.service.create(ctx, IDs.client, basicInput, bearer);
    await expect(
      f.service.create(
        ctx,
        IDs.client,
        { ...basicInput, activity: { ...basicInput.activity, title: 'Changed' } },
        bearer,
      ),
    ).rejects.toThrow('different activity data');
    expect(f.activities).toHaveLength(1);
  });
  it('creates one generic personal task with server-owned identity and no copied client information', async () => {
    const f = fixture();
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(first).toMatchObject({
      status: 'completed',
      version: 2,
      followUp: { taskId: IDs.task, state: 'completed' },
    });
    expect(first.commandId).not.toBe(IDs.request);
    expect(f.planner.create).toHaveBeenCalledWith(ctx, bearer, first.commandId, {
      name: 'Follow up on logged activity',
      description: '',
      assigneeId: 'user_assignee',
      dueOn: '2026-11-01',
      dueTime: '01:30',
      timeZone: 'America/New_York',
      clientId: null,
      meetingId: null,
      parentId: null,
      memberships: [],
      collaborators: [],
    });
    expect(JSON.stringify(f.rows[0].plannerPayload)).not.toContain('Private');
    await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    expect(f.activities).toHaveLength(1);
  });
  it('recovers a lost Planner response using GET and the same stored key', async () => {
    const f = fixture();
    f.planner.create.mockImplementationOnce(async (_ctx, _bearer, key) => {
      f.remote.set(key, IDs.task);
      return { kind: 'blocked', code: 'planner_unavailable' };
    });
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(first).toMatchObject({
      status: 'needs_attention',
      reason: 'planner_unavailable',
      version: 2,
    });
    const final = await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: 2 },
      bearer,
    );
    expect(final).toMatchObject({ status: 'completed', followUp: { taskId: IDs.task } });
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    expect(f.activities).toHaveLength(1);
  });
  it('recovers remote acceptance followed by a failed local commit after the old lease expires', async () => {
    const f = fixture();
    f.state.failCommitAfterRemote = true;
    await expect(f.service.create(ctx, IDs.client, followInput, bearer)).rejects.toThrow(
      'Synthetic commit',
    );
    expect(f.rows[0]).toMatchObject({ version: 1, status: 'pending', taskId: null });
    f.rows[0].leaseUntil = new Date(0);
    const final = await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: 1 },
      bearer,
    );
    expect(final.status).toBe('completed');
    expect(f.planner.create).toHaveBeenCalledTimes(1);
  });
  it('duplicate browser requests do not trigger a second in-flight attempt', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const enteredPromise = new Promise<void>((r) => {
      entered = r;
    });
    f.planner.lookup.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return { kind: 'missing' };
    });
    const first = f.service.create(ctx, IDs.client, followInput, bearer);
    await enteredPromise;
    const duplicate = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(duplicate.status).toBe('in_progress');
    expect(f.activities).toHaveLength(1);
    await expect(
      f.service.resume(
        ctx,
        IDs.client,
        IDs.request,
        { expectedVersion: duplicate.version },
        bearer,
      ),
    ).rejects.toThrow('already being attempted');
    release();
    await first;
    expect(f.planner.create).toHaveBeenCalledTimes(1);
  });
  it('rejects stale version before remote access', async () => {
    const f = fixture();
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    const reads = f.planner.lookup.mock.calls.length;
    await expect(
      f.service.resume(
        ctx,
        IDs.client,
        IDs.request,
        { expectedVersion: first.version - 1 },
        bearer,
      ),
    ).rejects.toThrow('version changed');
    expect(f.planner.lookup).toHaveBeenCalledTimes(reads);
  });
  it.each(['actorActive', 'clientActive', 'actorWall'] as const)(
    'denies %s revocation on read, replay and recovery',
    async (key) => {
      const f = fixture();
      const first = await f.service.create(ctx, IDs.client, followInput, bearer);
      f.state[key] = false;
      await expect(f.service.get(ctx, IDs.client, IDs.request, bearer)).rejects.toThrow(
        'not found',
      );
      await expect(f.service.create(ctx, IDs.client, followInput, bearer)).rejects.toThrow(
        'not found',
      );
      await expect(
        f.service.resume(ctx, IDs.client, IDs.request, { expectedVersion: first.version }, bearer),
      ).rejects.toThrow('not found');
      expect(f.planner.create).toHaveBeenCalledTimes(1);
    },
  );
  it.each([{ tenantId: IDs.client }, { userId: IDs.assignee }, { clerkUserId: 'user_changed' }])(
    'denies different context %j',
    async (change) => {
      const f = fixture();
      await f.service.create(ctx, IDs.client, basicInput, bearer);
      await expect(
        f.service.get({ ...ctx, ...change }, IDs.client, IDs.request, bearer),
      ).rejects.toThrow('not found');
    },
  );
  it.each(['assigneeActive', 'assigneeWall', 'personActive'] as const)(
    'holds pending intent after %s revocation',
    async (key) => {
      const f = fixture();
      f.planner.lookup.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_unavailable' });
      const first = await f.service.create(ctx, IDs.client, followInput, bearer);
      f.state[key] = false;
      const held = await f.service.resume(
        ctx,
        IDs.client,
        IDs.request,
        { expectedVersion: first.version },
        bearer,
      );
      expect(held.status).toBe('needs_attention');
      expect(f.planner.create).not.toHaveBeenCalled();
    },
  );
  it('fails closed on assignee or actor identity remapping', async () => {
    const f = fixture();
    f.planner.lookup.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_unavailable' });
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    f.state.assigneeClerk = 'user_reassigned';
    const held = await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: first.version },
      bearer,
    );
    expect(held.reason).toBe('assignee_unavailable');
    expect(f.planner.create).not.toHaveBeenCalled();
    f.state.actorClerk = 'user_reassigned_actor';
    await expect(
      f.service.get({ ...ctx, clerkUserId: f.state.actorClerk }, IDs.client, IDs.request, bearer),
    ).rejects.toThrow('not found');
  });
  it('checks revoked authority again between remote lookup and create', async () => {
    const f = fixture();
    f.planner.lookup.mockImplementationOnce(async () => {
      f.state.assigneeActive = false;
      return { kind: 'missing' };
    });
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(first.reason).toBe('assignee_unavailable');
    expect(f.planner.create).not.toHaveBeenCalled();
  });
  it('does not recreate a deleted activity or dispatch its task', async () => {
    const f = fixture();
    f.planner.lookup.mockResolvedValueOnce({ kind: 'blocked', code: 'planner_unavailable' });
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    f.activities.length = 0;
    const replay = await f.service.create(ctx, IDs.client, followInput, bearer);
    expect(replay).toMatchObject({
      reason: 'activity_removed',
      activity: { id: IDs.activity, available: false },
    });
    await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: first.version },
      bearer,
    );
    expect(f.activities).toHaveLength(0);
    expect(f.rows).toHaveLength(1);
    expect(f.planner.create).not.toHaveBeenCalled();
  });
  it('never replaces an accepted but deleted/denied task and withholds its destination', async () => {
    const f = fixture();
    const first = await f.service.create(ctx, IDs.client, followInput, bearer);
    f.remote.clear();
    const read = await f.service.get(ctx, IDs.client, IDs.request, bearer);
    expect(read).toMatchObject({
      status: 'needs_attention',
      reason: 'planner_receipt_unavailable',
      followUp: { state: 'unavailable', taskId: null },
    });
    await f.service.resume(
      ctx,
      IDs.client,
      IDs.request,
      { expectedVersion: first.version },
      bearer,
    );
    expect(f.planner.create).toHaveBeenCalledTimes(1);
    expect(f.rows[0].taskId).toBe(IDs.task);
  });
  it('does not return a success after Core authority is revoked during remote acceptance', async () => {
    const f = fixture();
    f.planner.create.mockImplementationOnce(async (_ctx, _bearer, key) => {
      f.remote.set(key, IDs.task);
      f.state.actorWall = false;
      return { kind: 'found', taskId: IDs.task };
    });
    await expect(f.service.create(ctx, IDs.client, followInput, bearer)).rejects.toThrow(
      'not found',
    );
    expect(f.rows[0].status).toBe('pending');
    expect(f.remote.size).toBe(1);
  });
  it('missing bridge configuration fails before local writes', async () => {
    const f = fixture();
    f.planner.origin.mockImplementation(() => {
      throw Error('Not configured');
    });
    await expect(f.service.create(ctx, IDs.client, followInput, bearer)).rejects.toThrow(
      'Not configured',
    );
    expect(f.rows).toHaveLength(0);
    expect(f.activities).toHaveLength(0);
  });
});
