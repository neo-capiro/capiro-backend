import { setup, ctx, tenant, client, ids } from './client-ordered-owner.test-support.js';

async function status(promise: Promise<unknown>, expected: number, code?: string) {
  try {
    await promise;
    throw Error('Expected failure');
  } catch (error: any) {
    expect(error.getStatus?.()).toBe(expected);
    if (code) expect(error.getResponse().code).toBe(code);
  }
}

describe('ordered client ownership', () => {
  test('persists four ranks, Primary and audit in one transaction and reads exact order', async () => {
    const { service, state } = setup();
    const saved = await service.replace(ctx, client, {
      expectedVersion: 0,
      userIds: ids.slice(0, 4),
    });
    expect(saved).toMatchObject({ tenantId: tenant, clientId: client, version: 1 });
    expect(saved.owners.map((o) => [o.userId, o.rank, o.label])).toEqual(
      ids
        .slice(0, 4)
        .map((id, i) => [id, i + 1, ['Primary', 'Secondary', 'Tertiary', 'Quaternary'][i]]),
    );
    expect(state.primary).toBe(ids[0]);
    expect(state.audits).toHaveLength(1);
    expect(await service.get(ctx, client)).toEqual(saved);
  });
  test('reorders, removes a middle rank contiguously, and clears all', async () => {
    const { service, state } = setup(ids.slice(0, 4));
    const next = [ids[3], ids[0], ids[2]];
    expect(
      (await service.replace(ctx, client, { expectedVersion: 0, userIds: next })).owners.map(
        (o) => o.userId,
      ),
    ).toEqual(next);
    expect(state.primary).toBe(ids[3]);
    expect(await service.replace(ctx, client, { expectedVersion: 1, userIds: [] })).toMatchObject({
      version: 2,
      owners: [],
    });
    expect(state.primary).toBeNull();
  });
  test.each([
    { expectedVersion: 0, userIds: [ids[0], ids[0]] },
    { expectedVersion: 0, userIds: [ids[0], ids[0].toUpperCase()] },
    { expectedVersion: 0, userIds: ids },
    { expectedVersion: 0, userIds: ['bad'] },
    { expectedVersion: -1, userIds: [] },
    { expectedVersion: 1.5, userIds: [] },
    { expectedVersion: 0, userIds: [], rank: 3 },
    { userIds: [] },
    { expectedVersion: 0, userIds: null },
  ])('rejects invalid complete replacements without a write: %j', async (body) => {
    const { service, tx } = setup([ids[0]]);
    await status(service.replace(ctx, client, body), 400);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  test.each(['inactive', 'foreign'])('rejects %s requested owner, retaining old set', async () => {
    const { service, state, tx } = setup([ids[0]]);
    state.members.delete(ids[1]);
    await status(service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[1]] }), 400);
    expect(state.owners).toEqual([ids[0]]);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
  test('retains an inactive historical rank as unavailable without promoting Secondary', async () => {
    const { service, state } = setup(ids.slice(0, 2));
    state.members.delete(ids[0]);
    const view = await service.get(ctx, client);
    expect(view.owners[0]).toMatchObject({
      userId: ids[0],
      rank: 1,
      available: false,
      person: null,
    });
    expect(view.owners[1]!.rank).toBe(2);
    expect(state.primary).toBe(ids[0]);
    await status(
      service.replace(ctx, client, { expectedVersion: 0, userIds: ids.slice(0, 2) }),
      400,
    );
  });
  test.each(['revoked', 'wrong_clerk', 'non_admin', 'unknown_role'])(
    'denies %s current actor before writes',
    async (kind) => {
      const { service, state, tx } = setup();
      if (kind === 'revoked') state.active = false;
      if (kind === 'non_admin') state.role = 'standard_user';
      if (kind === 'unknown_role') state.role = 'administrator-ish';
      await status(
        service.replace(kind === 'wrong_clerk' ? { ...ctx, clerkUserId: 'foreign' } : ctx, client, {
          expectedVersion: 0,
          userIds: [],
        }),
        403,
      );
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    },
  );
  test.each(['foreign_client', 'foreign_tenant', 'archived', 'wall'])(
    'does not disclose %s client',
    async (kind) => {
      const { service, state } = setup([ids[0]]);
      if (kind === 'archived') state.archived = true;
      if (kind === 'wall') state.wall = false;
      const actorCtx = kind === 'foreign_tenant' ? { ...ctx, tenantId: client } : ctx;
      await status(
        service.get(actorCtx, kind === 'foreign_client' ? ids[0] : client),
        kind === 'foreign_tenant' ? 403 : 404,
      );
    },
  );
  test('read is allowed for an active standard_user, write is not', async () => {
    const { service, state } = setup([ids[0]]);
    state.role = 'standard_user';
    expect((await service.get(ctx, client)).owners).toHaveLength(1);
    await status(service.replaceLegacy(ctx, client, null), 403);
  });
  test('two same-version replacements yield one receipt and one stale conflict', async () => {
    const { service, state, queries } = setup();
    const outcomes = await Promise.allSettled(
      ids
        .slice(0, 2)
        .map((id) => service.replace(ctx, client, { expectedVersion: 0, userIds: [id] })),
    );
    expect(outcomes.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((outcomes[1] as PromiseRejectedResult).reason.getResponse().code).toBe(
      'owner_version_changed',
    );
    expect(state.owners).toEqual([ids[0]]);
    expect(state.version).toBe(1);
    expect(
      queries
        .filter((q) => q.includes('account_owner_version'))
        .every((q) => q.includes('FOR UPDATE')),
    ).toBe(true);
  });
  test('audit failure rolls back ordered rows and compatibility projection', async () => {
    const { service, state } = setup([ids[0]]);
    state.auditFailure = true;
    await expect(
      service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[1]] }),
    ).rejects.toThrow('synthetic audit failure');
    expect(state).toMatchObject({ owners: [ids[0]], primary: ids[0], version: 0, audits: [] });
  });
  test('exact versioned no-op does not increment; stale exact retry still conflicts', async () => {
    const { service, state } = setup([ids[0]]);
    expect(
      (await service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[0]] })).version,
    ).toBe(0);
    await service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[1]] });
    await status(
      service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[1]] }),
      409,
      'owner_version_changed',
    );
    expect(state.version).toBe(1);
  });
  test('legacy single-owner writes and clear advance the canonical version', async () => {
    const { service, state } = setup();
    expect(await service.replaceLegacy(ctx, client, ids[0])).toMatchObject({
      accountOwnerUserId: ids[0],
      accountOwner: { id: ids[0] },
    });
    expect(state).toMatchObject({ version: 1, primary: ids[0], owners: [ids[0]] });
    await status(service.replace(ctx, client, { expectedVersion: 0, userIds: [ids[1]] }), 409);
    expect(await service.replaceLegacy(ctx, client, null)).toEqual({
      accountOwnerUserId: null,
      accountOwner: null,
    });
    expect(state.version).toBe(2);
  });
  test('legacy multi-owner exact no-op preserves set, including inactive Primary', async () => {
    const { service, state, tx } = setup(ids.slice(0, 3));
    state.members.delete(ids[0]);
    await service.replaceLegacy(ctx, client, ids[0]);
    expect(state.owners).toEqual(ids.slice(0, 3));
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    for (const primary of [null, ids[1], ids[3]])
      await status(service.replaceLegacy(ctx, client, primary), 409, 'ordered_owners_required');
  });
  test('maximum version permits a read/no-op but refuses every mutation before a write', async () => {
    const { service, state, tx } = setup([ids[0]]);
    state.version = 2147483647;
    expect(
      (await service.replace(ctx, client, { expectedVersion: 2147483647, userIds: [ids[0]] }))
        .version,
    ).toBe(2147483647);
    await status(
      service.replace(ctx, client, { expectedVersion: 2147483647, userIds: [] }),
      409,
      'owner_version_exhausted',
    );
    await status(service.replaceLegacy(ctx, client, null), 409, 'owner_version_exhausted');
    await status(service.replace(ctx, client, { expectedVersion: 2147483648, userIds: [] }), 400);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
