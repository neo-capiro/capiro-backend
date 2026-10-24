import { beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { activityUndoFixture, undoMigration } from './activity-undo-fixture.js';
import { actor, client, ctx, tenant, foreign, id, release, settled } from './fixture.js';

let h: Awaited<ReturnType<typeof activityUndoFixture>>;
const bearer = 'Bearer synthetic';
const creation = {
  requestId: id(900),
  activity: { kind: 'note', title: 'Synthetic Undo', body: 'Synthetic text' },
};
const revision = '2026-10-24T10:00:00.123456Z';
let input: { schemaVersion: 1; requestId: string; activityId: string; expectedRevision: string };
beforeAll(async () => {
  h = await activityUndoFixture();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
  const saved = await h.service.create(ctx, client, creation, bearer);
  input = {
    schemaVersion: 1,
    requestId: id(901),
    activityId: saved.activity.id,
    expectedRevision: revision,
  };
  await h.sql('UPDATE client_activity SET updated_at=$1::timestamptz WHERE id=$2', [
    revision,
    input.activityId,
  ]);
});
const undo = () => h.service.undo(ctx, client, creation.requestId, input, bearer);
const read = () => h.service.getUndo(ctx, client, creation.requestId, bearer);
const stored = async () =>
  (await h.sql('SELECT * FROM client_activity_commands WHERE request_id=$1', [creation.requestId]))
    .rows[0];
const activityCount = async () =>
  (await h.sql('SELECT count(*)::int AS count FROM client_activity')).rows[0].count;
function expectUndoRefusal(error: unknown, commandId: string) {
  expect(error).toBeInstanceOf(ConflictException);
  const failure = error as ConflictException;
  expect(failure.getStatus()).toBe(409);
  expect(failure.getResponse()).toEqual({
    schemaVersion: 1,
    commandId,
    creationRequestId: creation.requestId,
    tenantId: tenant,
    clientId: client,
    actorUserId: actor,
    activityId: input.activityId,
    code: 'ACTIVITY_UNDO_REFUSED',
    requestId: input.requestId,
    payloadDigest: createHash('sha256')
      .update(
        JSON.stringify([
          'activity-command-undo',
          1,
          tenant,
          actor,
          client,
          commandId,
          creation.requestId,
          input.requestId,
          input.activityId,
          input.expectedRevision,
        ]),
      )
      .digest('hex'),
    status: 409,
    message: 'The activity changed or is unavailable. This Undo removed no activity.',
  });
}

it('returns all six revision digits, commits one attributed inverse and recovers discarded response', async () => {
  const before = await stored();
  expect(await read()).toMatchObject({ status: 'available', revision });
  const [first, replay] = await Promise.all([undo(), undo()]);
  expect(replay).toEqual(first);
  expect(await read()).toEqual(first);
  expect(await activityCount()).toBe(0);
  const after = await stored();
  expect(after).toMatchObject({
    ...before,
    undo_request_id: input.requestId,
    undo_request_hash: first.undo.payloadDigest,
    undone_at: expect.any(Date),
  });
  expect(await h.service.create(ctx, client, creation, bearer)).toMatchObject({
    reason: 'activity_removed',
  });
  expect(await activityCount()).toBe(0);
});
it.each(['key', 'revision', 'activity'] as const)(
  'refuses changed %s after completion',
  async (field) => {
    const first = await undo();
    const changed = {
      ...input,
      ...(field === 'key'
        ? { requestId: id(902) }
        : field === 'activity'
          ? { activityId: id(903) }
          : { expectedRevision: '2026-10-24T10:00:00.123457Z' }),
    };
    await expect(
      h.service.undo(ctx, client, creation.requestId, changed, bearer),
    ).rejects.toMatchObject({ status: 409 });
    expect(await read()).toEqual(first);
  },
);
it('does not attribute another deletion and rejects foreign tenant reads', async () => {
  const commandId = (await stored()).id;
  await h.sql('DELETE FROM client_activity WHERE id=$1', [input.activityId]);
  expect(await read()).toMatchObject({ status: 'unavailable' });
  expectUndoRefusal((await settled(undo())).error, commandId);
  expect((await stored()).undo_request_id).toBeNull();
  await expect(
    h.service.getUndo({ ...ctx, tenantId: foreign }, client, creation.requestId, bearer),
  ).rejects.toThrow();
});
it('rolls back the deletion if writing the receipt fails', async () => {
  await h.sql(`CREATE FUNCTION fail_synthetic_undo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.undo_request_id IS NOT NULL THEN RAISE EXCEPTION 'Synthetic receipt failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER fail_synthetic_undo BEFORE UPDATE ON client_activity_commands FOR EACH ROW EXECUTE FUNCTION fail_synthetic_undo()`);
  try {
    await expect(undo()).rejects.toThrow();
    expect(await activityCount()).toBe(1);
    expect((await stored()).undo_request_id).toBeNull();
  } finally {
    await h.sql('DROP TRIGGER fail_synthetic_undo ON client_activity_commands');
  }
});
it('preserves write-once evidence and accepts reapplication of the forward migration', async () => {
  const receipt = await undo();
  for (const sql of [
    'UPDATE client_activity_commands SET undo_request_id=NULL,undo_request_hash=NULL,undone_at=NULL',
    "UPDATE client_activity_commands SET undo_request_hash=repeat('0',64)",
    "UPDATE client_activity_commands SET request_hash=repeat('0',64)",
  ]) {
    await expect(h.prisma.withTenant(tenant, (tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow();
  }
  await h.sql(undoMigration());
  expect(await read()).toEqual(receipt);
});
it('rechecks membership after waiting for the real client lock', async () => {
  const held = await h.lock('SELECT id FROM clients WHERE id=$1 FOR UPDATE', [client]);
  const pending = settled(undo());
  let released = false;
  try {
    await h.waitForLock('FROM clients');
    await h.sql(
      "UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2",
      [tenant, actor],
    );
    await release(held);
    released = true;
    expect((await pending).error).toMatchObject({ status: 403 });
    expect(await activityCount()).toBe(1);
    expect((await stored()).undo_request_id).toBeNull();
  } finally {
    if (!released) await release(held, false);
    await pending;
  }
});
it('preserves an edit committed while conditional DELETE waits for the activity row', async () => {
  const commandId = (await stored()).id;
  const held = await h.lock(
    "UPDATE client_activity SET title='Concurrent edit',updated_at='2026-10-24T10:00:00.123457Z' WHERE id=$1",
    [input.activityId],
  );
  const pending = settled(undo());
  let released = false;
  try {
    await h.waitForLock('DELETE FROM client_activity');
    await release(held);
    released = true;
    expectUndoRefusal((await pending).error, commandId);
    expect(
      (await h.sql('SELECT title FROM client_activity WHERE id=$1', [input.activityId])).rows[0]
        .title,
    ).toBe('Concurrent edit');
    expect((await stored()).undo_request_id).toBeNull();
  } finally {
    if (!released) await release(held, false);
    await pending;
  }
});
it.each(['member', 'wall'] as const)(
  'holds %s authority through a later activity-row wait and the effect',
  async (kind) => {
    if (kind === 'wall') {
      await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
      await h.sql(
        'INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)',
        [tenant, client, actor],
      );
    }
    const held = await h.lock('SELECT id FROM client_activity WHERE id=$1 FOR UPDATE', [
      input.activityId,
    ]);
    const pending = settled(undo());
    let released = false;
    let removal: ReturnType<typeof settled> | undefined;
    try {
      await h.waitForLock('DELETE FROM client_activity');
      removal = settled(
        h.prisma.withTenant(tenant, (tx) =>
          kind === 'member'
            ? tx.$executeRaw`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=${tenant}::uuid AND user_id=${actor}::uuid`
            : tx.$executeRaw`DELETE FROM client_memory_access WHERE tenant_id=${tenant}::uuid AND client_id=${client}::uuid AND user_id=${actor}::uuid`,
        ),
      );
      await h.waitForLock(
        kind === 'member' ? 'UPDATE tenant_memberships' : 'DELETE FROM client_memory_access',
      );
      await release(held);
      released = true;
      expect((await pending).value).toMatchObject({ status: 'removed' });
      expect((await removal).error).toBeUndefined();
      expect(await activityCount()).toBe(0);
      await expect(read()).rejects.toThrow();
    } finally {
      if (!released) await release(held, false);
      await Promise.all([pending, removal]);
    }
  },
);
