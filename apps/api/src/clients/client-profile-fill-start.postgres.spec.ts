import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { createResearchRun } from './client-profile-fill-run-create.js';
import { readResearchStart, researchStartRequest } from './client-profile-fill-start-request.js';
import { ClientProfileFillWorkflowService, type StartClientProfileFillWorkflowInput } from './client-profile-fill-workflow.service.js';
import { researchStartDatabase } from './client-profile-fill-start.postgres-fixture.js';
import { seedCompletionTasks } from './client-profile-fill-completion-plan-store.js';
import { ClientProfileFillTaskLedger } from './client-profile-fill-task-ledger.js';

const url = process.env.FILL_START_TEST_DATABASE_URL;
(url ? describe : describe.skip)('research starts through current ownership and PostgreSQL', () => {
  let store: Awaited<ReturnType<typeof researchStartDatabase>>, ctx: TenantContext, clientId: string;
  let input: StartClientProfileFillWorkflowInput;
  beforeAll(async () => { store = await researchStartDatabase(url!); }, 60000);
  afterAll(async () => { await store?.db.$disconnect(); });
  beforeEach(async () => {
    const tenantId = randomUUID(), userId = randomUUID();
    clientId = randomUUID();
    ctx = { tenantId, userId, role: 'standard_user', clerkUserId: 'synthetic-' + userId, tenantSlug: 'synthetic-' + tenantId };
    await store.db.tenant.create({ data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic', status: 'active' } });
    await store.db.user.create({ data: { id: userId, clerkUserId: ctx.clerkUserId, email: userId + '@example.invalid' } });
    await store.db.tenantMembership.create({ data: { tenantId, userId, role: ctx.role, status: 'active' } });
    await store.db.client.create({ data: { id: clientId, tenantId, name: 'Synthetic', status: 'active' } });
    input = { requestId: randomUUID(), sources: ['public_web'], website: 'https://research.example/' };
  });
  const allocation = (actor = ctx, client = clientId, command = input) => ({
    sources: ['public_web'], sourceStates: { public_web: { status: 'queued', count: 0 } },
    setup: { website: command.website }, selectedLdaIds: [], attachmentIds: [],
    plan: [{ taskType: 'public_web' as const, taskKey: 'public_web', dependsOnKeys: [], input: { researchInputVersion: 1, website: command.website } }],
    request: researchStartRequest(actor, client, command)!,
  });
  const create = () => createResearchRun(store.scoped, ctx, clientId, allocation());
  const read = () => readResearchStart(store.scoped, ctx, clientId, allocation().request);

  test('concurrent identical starts atomically commit one run and its complete task plan', async () => {
    const results = await Promise.all([create(), create()]);
    expect(results.map(row => row.runId)).toEqual([input.requestId, input.requestId]);
    expect(results.filter(row => row.created)).toHaveLength(1);
    const [counts] = await store.db.$queryRawUnsafe<Array<{ runs: number; tasks: number; extensions: number }>>(
      `SELECT (SELECT count(*)::int FROM client_profile_fill_run WHERE id=$1::uuid) AS runs,
        (SELECT count(*)::int FROM client_profile_fill_task WHERE run_id=$1::uuid) AS tasks,
        (SELECT count(*)::int FROM client_profile_fill_extension_task WHERE run_id=$1::uuid) AS extensions`, input.requestId,
    );
    expect(counts).toEqual({ runs: 1, tasks: 1, extensions: 7 });
  });
  test('follow-up tasks stay idle until preparation succeeds', async () => {
    await create();
    const ledger = new ClientProfileFillTaskLedger({
      withSystem: (fn: Parameters<typeof store.scoped.withTenantUser>[2]) =>
        store.scoped.withTenantUser(ctx.tenantId, ctx.userId, fn),
    } as never, 'fixture-worker', { safeError: String });
    expect(await ledger.claimTasks()).toEqual([]);
    await store.db.$executeRawUnsafe("UPDATE client_profile_fill_run SET stage='research' WHERE id=$1::uuid", input.requestId);
    expect((await ledger.claimTasks()).map(task => task.taskKey).sort()).toEqual([
      'advocacy_history', 'facility_resolution', 'federal_market',
    ]);
  });
  test('recovery fills a missing plan once and cannot reseed a cancelled run', async () => {
    await create();
    await store.db.$executeRawUnsafe('DELETE FROM client_profile_fill_extension_task WHERE run_id=$1::uuid', input.requestId);
    const seed = () => store.scoped.withTenantUser(ctx.tenantId, ctx.userId,
      tx => seedCompletionTasks(tx, ctx.tenantId, clientId, input.requestId!));
    await Promise.all([seed(), seed()]);
    const rows = await store.db.$queryRawUnsafe<Array<{ id: string }>>(
      'SELECT id FROM client_profile_fill_extension_task WHERE run_id=$1::uuid', input.requestId);
    expect(rows).toHaveLength(7);
    await store.db.$executeRawUnsafe("UPDATE client_profile_fill_run SET status='cancelled', stage='cancelled' WHERE id=$1::uuid", input.requestId);
    await expect(seed()).rejects.toMatchObject({ status: 404 });
  });
  test('a follow-up task failure rolls back the run and both ledgers', async () => {
    const failing = {
      withTenantUser: (tenant: string, actor: string, fn: Parameters<typeof store.scoped.withTenantUser>[2]) =>
        store.scoped.withTenantUser(tenant, actor, tx => fn(new Proxy(tx, {
          get(target, key) {
            if (key === '$executeRawUnsafe') return (sql: string, ...args: unknown[]) => {
              if (sql.includes('INSERT INTO client_profile_fill_extension_task') && args[3] === 'district_nexus')
                throw Error('Injected completion task failure');
              return target.$executeRawUnsafe(sql, ...args);
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }))),
    };
    await expect(createResearchRun(failing as never, ctx, clientId, allocation())).rejects.toThrow('Injected completion task failure');
    expect(await read()).toBeNull();
    expect(await store.db.$queryRawUnsafe('SELECT id FROM client_profile_fill_task WHERE run_id=$1::uuid', input.requestId)).toEqual([]);
    expect(await store.db.$queryRawUnsafe('SELECT id FROM client_profile_fill_extension_task WHERE run_id=$1::uuid', input.requestId)).toEqual([]);
  });
  test('a retry reads the same completed run before refreshing sources or creating tasks', async () => {
    await create();
    await store.db.$executeRawUnsafe("UPDATE client_profile_fill_run SET status='completed' WHERE id=$1::uuid", input.requestId);
    const service = new ClientProfileFillWorkflowService(store.scoped, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never) as any;
    service.getRun = jest.fn(async (_ctx: unknown, _client: string, id: string) => ({ id, status: 'completed' }));
    service.getSetup = jest.fn();
    expect(await service.startRun(ctx, clientId, input)).toEqual({ id: input.requestId, status: 'completed' });
    expect(service.getSetup).not.toHaveBeenCalled();
    expect(await create()).toEqual({ runId: input.requestId, created: false });
  });
  test('changed inputs cannot replace an existing request or create additional work', async () => {
    await create();
    input.website = 'https://different.example/';
    await expect(read()).rejects.toMatchObject({ status: 409 });
    await expect(create()).rejects.toMatchObject({ status: 409 });
  });
  test('a different explicit request cannot adopt another active run', async () => {
    await create();
    input.requestId = randomUUID();
    await expect(create()).rejects.toMatchObject({ status: 409 });
    expect(await read()).toBeNull();
  });
  test.each(['wall', 'archive', 'membership', 'role', 'tenant'] as const)('current %s changes revoke start and recovery', async mode => {
    await create();
    if (mode === 'wall') await store.db.client.update({ where: { id: clientId }, data: { memoryWall: true } });
    if (mode === 'archive') await store.db.client.update({ where: { id: clientId }, data: { status: 'archived' } });
    if (mode === 'membership') await store.db.tenantMembership.updateMany({ where: { tenantId: ctx.tenantId, userId: ctx.userId }, data: { status: 'removed' } });
    if (mode === 'role') await store.db.tenantMembership.updateMany({ where: { tenantId: ctx.tenantId, userId: ctx.userId }, data: { role: 'user_admin' } });
    if (mode === 'tenant') await store.db.tenant.update({ where: { id: ctx.tenantId }, data: { status: 'suspended' } });
    await expect(read()).rejects.toMatchObject({ status: mode === 'wall' || mode === 'archive' ? 404 : 403 });
    await expect(create()).rejects.toBeDefined();
  });
  test('another permitted actor cannot claim the original request identity', async () => {
    await create();
    const userId = randomUUID(), clerkUserId = 'synthetic-' + userId;
    await store.db.user.create({ data: { id: userId, clerkUserId, email: userId + '@example.invalid' } });
    await store.db.tenantMembership.create({ data: { tenantId: ctx.tenantId, userId, role: ctx.role, status: 'active' } });
    const actor = { ...ctx, userId, clerkUserId };
    await expect(createResearchRun(store.scoped, actor, clientId, allocation(actor))).rejects.toMatchObject({ status: 409 });
  });
  test('a foreign-client UUID collision refuses without returning the other run', async () => {
    await create();
    const other = await store.db.client.create({ data: { tenantId: ctx.tenantId, name: 'Other synthetic', status: 'active' } });
    const command = allocation(ctx, other.id);
    await expect(createResearchRun(store.scoped, ctx, other.id, command)).rejects.toMatchObject({ status: 409 });
    expect(await readResearchStart(store.scoped, ctx, other.id, command.request)).toBeNull();
  });
  test('a task insert failure rolls back the run identity too', async () => {
    const command = allocation();
    command.plan[0]!.taskType = 'unsupported' as 'public_web';
    await expect(createResearchRun(store.scoped, ctx, clientId, command)).rejects.toBeDefined();
    expect(await read()).toBeNull();
  });
});
