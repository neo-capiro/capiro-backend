import { beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import {
  associationsFixture,
  objective,
  revision,
  sources,
  links,
} from './associations-fixture.js';
import { actor, ctx, tenant, client, foreign, outsider, id, release, settled } from './fixture.js';
import { listOperationalLinks } from '../../src/clients/objectives/operational/objective-operational.store.js';
import type { OperationalUnlinkCommand } from '../../src/clients/objectives/operational/objective-operational.types.js';

let h: Awaited<ReturnType<typeof associationsFixture>>;
beforeAll(async () => {
  h = await associationsFixture();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});
const request = (cursor: string | null = null, limit = 2) => ({
  schemaVersion: 1 as const,
  clientId: client,
  objectiveId: objective,
  limit,
  cursor,
});
const unlink = (): OperationalUnlinkCommand => ({
  schemaVersion: 1,
  requestId: id(230),
  clientId: client,
  objectiveId: objective,
  expectedObjectiveVersion: 1,
  expectedAssociationSetVersion: 4,
  action: 'unlink',
  associationId: links[0]!,
});

it('executes real parameterized LIMIT/OFFSET and preserves legacy unbounded callers', async () => {
  const first = await h.service.associations(ctx, request());
  expect(first.items.map((v) => v.associationId)).toEqual(links.slice(0, 2));
  expect(first).toMatchObject({ associationSetVersion: 4, pageCoverage: 'complete' });
  expect(first.nextCursor).toEqual(expect.any(String));
  const second = await h.service.associations(ctx, request(first.nextCursor));
  expect(second.items.map((v) => v.associationId)).toEqual(links.slice(2));
  expect(second).toMatchObject({ asOf: first.asOf, nextCursor: null, pageCoverage: 'complete' });
  const all = await h.prisma.withTenant(tenant, (tx) => listOperationalLinks(tx, ctx, first.scope));
  expect(all.map((v) => v.id)).toEqual(links);
  const one = await h.service.associations(ctx, request(null, 1));
  expect(one.items).toHaveLength(1);
  const last = await h.service.associations(ctx, request(null, 100));
  expect(last.items).toHaveLength(4);
  expect(last.nextCursor).toBeNull();
});

it('rechecks actual Planner ACL on each page without leaking hidden link or resource metadata', async () => {
  const first = await h.service.associations(ctx, request(null, 1));
  await h.sql(`UPDATE sp_planner_projects SET owner_id='a2-synthetic-other' WHERE id=$1`, [
    sources[1],
  ]);
  const hidden = await h.service.associations(ctx, request(first.nextCursor, 1));
  expect(hidden.items).toEqual([]);
  expect(hidden.pageCoverage).toBe('partial');
  expect(hidden.nextCursor).toEqual(expect.any(String));
  const body = JSON.stringify(hidden);
  for (const privateValue of [sources[1], links[1], 'Synthetic planner_project 1'])
    expect(body).not.toContain(privateValue);
  expect(hidden).not.toHaveProperty('total');
  const next = await h.service.associations(ctx, request(hidden.nextCursor, 1));
  expect(next.items.map((v) => v.associationId)).toEqual([links[2]]);
  expect(next.asOf).toBe(first.asOf);
});

it('checks current tenant, member, client wall and source feature policy using real owner queries', async () => {
  await expect(
    h.service.associations({ ...ctx, tenantId: foreign }, request()),
  ).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  await expect(
    h.service.associations({ ...ctx, userId: outsider }, request()),
  ).rejects.toMatchObject({ code: 'NOT_AVAILABLE' });
  await h.sql('UPDATE clients SET memory_wall=true WHERE id=$1', [client]);
  await expect(h.service.associations(ctx, request())).rejects.toMatchObject({
    code: 'NOT_AVAILABLE',
  });
  await h.sql('INSERT INTO client_memory_access(tenant_id,client_id,user_id) VALUES($1,$2,$3)', [
    tenant,
    client,
    actor,
  ]);
  expect((await h.service.associations(ctx, request())).items).toHaveLength(2);
  await h.sql(`UPDATE tenants SET settings_jsonb='{}' WHERE id=$1`, [tenant]);
  const noStrategy = await h.service.associations(ctx, request(null, 1));
  expect(noStrategy).toMatchObject({ items: [], pageCoverage: 'partial' });
  await h.sql(`UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`, [
    tenant,
    actor,
  ]);
  await expect(h.service.associations(ctx, request())).rejects.toMatchObject({
    code: 'NOT_AVAILABLE',
  });
});

it('invalidates an old cursor after a canonical unlink commit and preserves its exact receipt', async () => {
  const first = await h.service.associations(ctx, request());
  const command = unlink();
  const receipt = await h.service.command(ctx, command);
  expect(receipt).toMatchObject({
    outcome: 'unlinked',
    resultSetVersion: 5,
    associationId: links[0],
  });
  await expect(h.service.associations(ctx, request(first.nextCursor))).rejects.toMatchObject({
    code: 'CURSOR_STALE',
  });
  expect(
    await h.service.receipt(ctx, {
      schemaVersion: 1,
      clientId: client,
      objectiveId: objective,
      requestId: command.requestId,
    }),
  ).toEqual(receipt);
  const refreshed = await h.service.associations(ctx, request());
  expect(refreshed.items.map((v) => v.associationId)).toEqual(links.slice(1, 3));
  expect(refreshed.associationSetVersion).toBe(5);
});

it('waits behind the actual mutation gate then refuses the old cursor after commit', async () => {
  const first = await h.service.associations(ctx, request());
  const stateLock = await h.lock(
    'SELECT version FROM client_objective_operational_states WHERE objective_id=$1 FOR UPDATE',
    [objective],
  );
  const mutation = settled(h.service.command(ctx, unlink()));
  let reading:
    ReturnType<typeof settled<Awaited<ReturnType<typeof h.service.associations>>>> | undefined;
  try {
    await h.waitForLock('FROM client_objective_operational_states');
    reading = settled(h.service.associations(ctx, request(first.nextCursor)));
    await h.waitForLock('pg_advisory_xact_lock_shared');
  } finally {
    await release(stateLock);
  }
  expect((await mutation).value).toMatchObject({ outcome: 'unlinked', resultSetVersion: 5 });
  expect((await reading)?.error).toMatchObject({ code: 'CURSOR_STALE' });
});

it('rechecks a current membership after a real row-lock wait', async () => {
  const membership = await h.lock(
    `UPDATE tenant_memberships SET status='removed' WHERE tenant_id=$1 AND user_id=$2`,
    [tenant, actor],
  );
  const pending = settled(h.service.associations(ctx, request()));
  try {
    await h.waitForLock('JOIN tenant_memberships');
  } finally {
    await release(membership);
  }
  expect((await pending).error).toMatchObject({ code: 'NOT_AVAILABLE' });
});

it('binds paging to the current Objective revision and actor rather than merely matching an offset', async () => {
  const first = await h.service.associations(ctx, request());
  await expect(
    h.service.associations(
      { ...ctx, userId: outsider, clerkUserId: 'a2-synthetic-other' },
      request(first.nextCursor),
    ),
  ).rejects.toMatchObject({ code: 'CURSOR_STALE' });
  await expect(h.service.associations(ctx, request(first.nextCursor, 1))).rejects.toMatchObject({
    code: 'CURSOR_STALE',
  });
  await h.sql(
    `INSERT INTO client_objective_revisions(id,tenant_id,client_id,objective_id,version,operation,actor_user_id,snapshot)
    VALUES($1,$2,$3,$4,2,'edit',$5,'{}')`,
    [id(240), tenant, client, objective, actor],
  );
  await h.sql('UPDATE client_objectives SET version=2 WHERE id=$1', [objective]);
  await expect(h.service.associations(ctx, request(first.nextCursor))).rejects.toMatchObject({
    code: 'CURSOR_STALE',
  });
  const refreshed = await h.service.associations(ctx, request());
  expect(refreshed.scope).toMatchObject({ objectiveVersion: 2, currentRevisionId: id(240) });
  expect(refreshed.items[0]?.linkedRevision).toEqual({ id: revision, version: 1 });
});
