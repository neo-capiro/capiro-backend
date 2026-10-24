import {
  bearer,
  basicInput,
  ctx,
  fixture,
  followInput,
  IDs,
} from '../../../test/support/activity-command.fixture.js';
import { ActivityCommandController } from './activity-command.controller.js';

const undoId = '90000000-0000-4000-8000-000000000001';
const revision = '2026-10-24T10:00:00.123456Z';
const input = {
  schemaVersion: 1,
  requestId: undoId,
  activityId: IDs.activity,
  expectedRevision: revision,
};

it('rejects impersonation on both Undo endpoints without starting an HTTP server', async () => {
  const f = fixture();
  const controller = new ActivityCommandController(f.service);
  const request = {
    headers: { authorization: bearer, 'x-capiro-impersonate-tenant': IDs.tenant },
  } as never;
  expect(() => controller.getUndo(ctx, IDs.client, IDs.request, request)).toThrow();
  expect(() => controller.undo(ctx, IDs.client, IDs.request, input, request)).toThrow();
  expect(f.prisma.withTenant).not.toHaveBeenCalled();
});
async function setup() {
  const f = fixture();
  const original = await f.service.create(ctx, IDs.client, basicInput, bearer);
  Object.assign(f.activities[0], {
    pinned: false,
    settledAt: null,
    dueAt: null,
    metadata: {},
    revision,
  });
  const calls: string[] = [];
  let afterClientLock = () => {};
  let beforeDelete = () => {};
  let failReceipt = false;
  (f.tx.$queryRaw as jest.Mock).mockImplementation(async (strings: any, ...values: any[]) => {
    const sql = strings.join('?');
    calls.push(sql);
    if (sql.includes('FROM clients')) {
      afterClientLock();
      return f.state.clientActive ? [{ version: 0, primary: null }] : [];
    }
    if (sql.includes('FOR SHARE OF tm'))
      return f.state.actorActive && f.state.actorClerk === ctx.clerkUserId
        ? [{ role: f.state.role }]
        : [];
    if (sql.includes('FROM client_memory_access')) return [];
    if (sql.includes('FROM client_activity_commands')) {
      const row = f.rows[0];
      return row.undoRequestId
        ? [
            {
              requestId: row.undoRequestId,
              payloadDigest: row.undoRequestHash,
              removedAt: row.undoneAt,
            },
          ]
        : [];
    }
    if (sql.includes('FROM client_activity') && sql.includes('FOR SHARE'))
      return f.activities.map((a) => ({ revision: a.revision }));
    if (sql.startsWith('DELETE FROM client_activity')) {
      beforeDelete();
      const a = f.activities[0];
      if (
        !a ||
        a.revision !== values[5] ||
        a.pinned ||
        a.settledAt ||
        a.sourceId !== f.rows[0].id ||
        a.createdByUserId !== ctx.userId
      )
        return [];
      f.activities.splice(0, 1);
      return [{ id: IDs.activity }];
    }
    if (sql.startsWith('UPDATE client_activity_commands')) {
      if (failReceipt) throw Error('Synthetic receipt insert failure');
      Object.assign(f.rows[0], {
        undoRequestId: values[0],
        undoRequestHash: values[1],
        undoneAt: '2026-10-24T11:00:00.654321Z',
      });
      return [{ requestId: values[0], payloadDigest: values[1], removedAt: f.rows[0].undoneAt }];
    }
    return [];
  });
  return {
    ...f,
    original,
    calls,
    afterClient: (fn: () => void) => {
      afterClientLock = fn;
    },
    beforeDelete: (fn: () => void) => {
      beforeDelete = fn;
    },
    failReceipt: () => {
      failReceipt = true;
    },
  };
}

it('returns a precise current revision, atomically removes once and recovers the same attributable receipt', async () => {
  const f = await setup();
  const before = structuredClone(f.rows[0]);
  expect(await f.service.getUndo(ctx, IDs.client, IDs.request, bearer)).toMatchObject({
    status: 'available',
    revision,
  });
  const removed = await f.service.undo(ctx, IDs.client, IDs.request, input, bearer);
  expect(removed).toMatchObject({
    status: 'removed',
    commandId: f.original.commandId,
    creationRequestId: IDs.request,
    activityId: IDs.activity,
    undo: { requestId: undoId },
  });
  expect(await f.service.getUndo(ctx, IDs.client, IDs.request, bearer)).toEqual(removed);
  expect(await f.service.undo(ctx, IDs.client, IDs.request, input, bearer)).toEqual(removed);
  expect(f.calls.filter((q) => q.startsWith('DELETE'))).toHaveLength(1);
  expect(f.activities).toHaveLength(0);
  expect(f.rows[0]).toMatchObject(before);
  expect(await f.service.create(ctx, IDs.client, basicInput, bearer)).toMatchObject({
    reason: 'activity_removed',
  });
  expect(f.activities).toHaveLength(0);
});
it('rolls back deletion when receipt persistence fails', async () => {
  const f = await setup();
  f.failReceipt();
  await expect(f.service.undo(ctx, IDs.client, IDs.request, input, bearer)).rejects.toThrow(
    'Synthetic',
  );
  expect(f.activities).toHaveLength(1);
  expect(f.rows[0].undoRequestId).toBeUndefined();
});
it.each(['edit', 'pin', 'missing'] as const)(
  'refuses a concurrent %s without claiming removal',
  async (change) => {
    const f = await setup();
    f.beforeDelete(() => {
      if (change === 'missing') f.activities.splice(0, 1);
      else if (change === 'pin') f.activities[0].pinned = true;
      else f.activities[0].revision = '2026-10-24T10:00:00.123457Z';
    });
    await expect(f.service.undo(ctx, IDs.client, IDs.request, input, bearer)).rejects.toThrow(
      'not confirmed',
    );
    expect(f.rows[0].undoRequestId).toBeUndefined();
  },
);
it('does not infer completed Undo from another deletion', async () => {
  const f = await setup();
  f.activities.splice(0, 1);
  expect(await f.service.getUndo(ctx, IDs.client, IDs.request, bearer)).toMatchObject({
    status: 'unavailable',
  });
  await expect(f.service.undo(ctx, IDs.client, IDs.request, input, bearer)).rejects.toThrow(
    'not confirmed',
  );
});
it.each([
  { expectedRevision: '2026-10-24T10:00:00.123457Z' },
  { requestId: '90000000-0000-4000-8000-000000000002' },
  { activityId: '80000000-0000-4000-8000-000000000002' },
])('refuses identity or payload substitution after completion %j', async (change) => {
  const f = await setup();
  await f.service.undo(ctx, IDs.client, IDs.request, input, bearer);
  await expect(
    f.service.undo(ctx, IDs.client, IDs.request, { ...input, ...change }, bearer),
  ).rejects.toThrow();
  expect(f.calls.filter((q) => q.startsWith('DELETE'))).toHaveLength(1);
});
it('rechecks membership after the client lock wait, before any effect', async () => {
  const f = await setup();
  f.afterClient(() => {
    f.state.actorActive = false;
  });
  await expect(f.service.undo(ctx, IDs.client, IDs.request, input, bearer)).rejects.toThrow(
    'denied',
  );
  expect(f.calls.filter((q) => q.startsWith('DELETE'))).toHaveLength(0);
  expect(f.activities).toHaveLength(1);
});
it('holds canonical authority locks before an activity-row wait and denies revoked receipt reads', async () => {
  const f = await setup();
  f.beforeDelete(() => {
    expect(f.calls.findIndex((q) => q.includes('FROM clients'))).toBeLessThan(
      f.calls.findIndex((q) => q.includes('FOR SHARE OF tm')),
    );
    expect(
      f.calls.some((q) => q.includes('FROM client_memory_access') && q.includes('FOR SHARE')),
    ).toBe(true);
  });
  await f.service.undo(ctx, IDs.client, IDs.request, input, bearer);
  f.state.actorWall = false;
  await expect(f.service.getUndo(ctx, IDs.client, IDs.request, bearer)).rejects.toThrow(
    'Client not found',
  );
});
it('refuses optional Planner commands and malformed or foreign inputs', async () => {
  const f = await setup();
  for (const body of [
    { ...input, expectedRevision: revision.slice(0, -4) + 'Z' },
    { ...input, extra: true },
  ])
    await expect(f.service.undo(ctx, IDs.client, IDs.request, body, bearer)).rejects.toThrow(
      'Invalid',
    );
  await expect(
    f.service.undo({ ...ctx, clerkUserId: 'other' }, IDs.client, IDs.request, input, bearer),
  ).rejects.toThrow();
  const follow = fixture();
  await follow.service.create(ctx, IDs.client, followInput, bearer);
  f.rows[0].assigneeUserId = IDs.assignee;
  await expect(f.service.getUndo(ctx, IDs.client, IDs.request, bearer)).rejects.toThrow(
    'without a follow-up',
  );
  expect(f.activities).toHaveLength(1);
});
