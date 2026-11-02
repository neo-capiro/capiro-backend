import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { readTargetContext } from './client-target-context.js';
import { targetContextDatabase } from './client-target-context.postgres-fixture.js';

const url = process.env.TARGET_CONTEXT_TEST_DATABASE_URL;
(url ? describe : describe.skip)('saved target reverse context — ordinary PostgreSQL role', () => {
  let store: Awaited<ReturnType<typeof targetContextDatabase>>;
  let ctx: TenantContext, clientId: string, targetId: string;
  beforeAll(async () => {
    store = await targetContextDatabase(url!);
  }, 60000);
  afterAll(async () => {
    await store?.db.$disconnect();
  });
  beforeEach(async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    clientId = randomUUID();
    targetId = randomUUID();
    ctx = {
      tenantId,
      userId,
      clerkUserId: `target-${userId}`,
      tenantSlug: `target-${tenantId}`,
      role: 'standard_user',
    };
    await store.db.tenant.create({
      data: { id: tenantId, slug: ctx.tenantSlug, name: 'Synthetic tenant', status: 'active' },
    });
    await store.db.user.create({
      data: { id: userId, clerkUserId: ctx.clerkUserId, email: `${userId}@example.invalid` },
    });
    await store.db.tenantMembership.create({
      data: { tenantId, userId, role: ctx.role, status: 'active' },
    });
    await store.db.client.create({
      data: { id: clientId, tenantId, name: 'Synthetic client', status: 'active' },
    });
    await store.db.clientTarget.create({
      data: { id: targetId, tenantId, clientId, memberId: 'M000001', sourceDirectory: 'congress' },
    });
  });
  const read = (section: 'objectives' | 'steps', after?: string) =>
    readTargetContext(store.scoped, ctx, clientId, targetId, {
      section,
      ...(after ? { after } : {}),
    });
  async function strategy(
    options: { tenantId?: string; clientId?: string; archived?: boolean } = {},
  ) {
    const id = randomUUID();
    await store.db.$executeRaw`INSERT INTO sp_strategy
      (id,tenant_id,client_id,title,type,owner_user_id,created_by_user_id,updated_at,archived_at)
      VALUES (${id}::uuid,${options.tenantId ?? ctx.tenantId}::uuid,${options.clientId ?? clientId}::uuid,
        ${'Strategy ' + id},'appropriations',${ctx.clerkUserId},${ctx.clerkUserId},now(),${options.archived ? new Date() : null})`;
    return id;
  }
  async function step(
    strategyId: string,
    target: unknown = { clientTargetId: targetId },
    options: { id?: string; tenantId?: string; archived?: boolean; ongoing?: boolean } = {},
  ) {
    const id = options.id ?? randomUUID();
    await store.db.$executeRaw`INSERT INTO sp_node
      (id,tenant_id,strategy_id,title,kind,subject,status,starts_on,ends_on,open_ended,target_ref,created_by_user_id,updated_at,archived_at)
      VALUES (${id}::uuid,${options.tenantId ?? ctx.tenantId}::uuid,${strategyId}::uuid,${'Step ' + id},'action','ask','active',
        '2026-10-29'::date,${options.ongoing ? null : '2026-11-03'}::date,${!!options.ongoing},${JSON.stringify(target)}::jsonb,
        ${ctx.clerkUserId},now(),${options.archived ? new Date() : null})`;
    return id;
  }
  async function objective(
    options: { deleted?: boolean; clientId?: string; tenantId?: string } = {},
  ) {
    const row = await store.db.clientObjective.create({
      data: {
        tenantId: options.tenantId ?? ctx.tenantId,
        clientId: options.clientId ?? clientId,
        clientRequestId: randomUUID(),
        createRequestHash: 'a'.repeat(64),
        createdByUserId: ctx.userId,
        outcome: 'Saved outcome',
        askType: 'funding',
        minimumWin: 'Saved minimum win',
        status: 'ready',
        version: 3,
        deletedAt: options.deleted ? new Date() : null,
      },
    });
    return row;
  }
  async function link(
    objectiveId: string,
    options: { removed?: boolean; target?: string; clientId?: string; tenantId?: string } = {},
  ) {
    await store.db.clientObjectiveResourceLink.create({
      data: {
        tenantId: options.tenantId ?? ctx.tenantId,
        clientId: options.clientId ?? clientId,
        objectiveId,
        linkedRevisionId: randomUUID(),
        linkedObjectiveVersion: 1,
        resourceKind: 'directory_target',
        resourceId: options.target ?? targetId,
        linkedByUserId: ctx.userId,
        removedAt: options.removed ? new Date() : null,
      },
    });
  }
  it('returns exact IDs and current fields across strategies, preserving point/range/ongoing semantics', async () => {
    const a = await strategy(),
      b = await strategy();
    const first = await step(a),
      second = await step(b, { clientTargetId: targetId.toUpperCase() }, { ongoing: true });
    const page = await read('steps');
    expect(page.items.map((row) => row.id)).toEqual([first, second].sort());
    expect(page.items).toContainEqual(
      expect.objectContaining({
        id: first,
        strategyId: a,
        subject: 'ask',
        status: 'active',
        startsOn: '2026-10-29',
        endsOn: '2026-11-03',
        openEnded: false,
      }),
    );
    expect(page.items).toContainEqual(
      expect.objectContaining({ id: second, strategyId: b, endsOn: null, openEnded: true }),
    );
    expect(page).toMatchObject({
      schemaVersion: 1,
      clientId,
      targetId,
      section: 'steps',
      nextCursor: null,
    });
  });
  it('admits only complete legacy directory identity, never conflicting saved IDs or names', async () => {
    const s = await strategy();
    const valid = await step(s, { memberId: 'M000001', sourceDirectory: 'congress' });
    for (const ref of [
      { memberId: 'M000001' },
      { memberId: 'M000001', sourceDirectory: 'staff' },
      { memberName: 'M000001' },
      { clientTargetId: randomUUID(), memberId: 'M000001', sourceDirectory: 'congress' },
      { clientTargetId: 'invalid', memberId: 'M000001', sourceDirectory: 'congress' },
      null,
    ])
      await step(s, ref);
    expect((await read('steps')).items.map((row) => row.id)).toEqual([valid]);
  });
  it('excludes archived strategies/nodes, foreign clients and foreign tenant rows', async () => {
    const live = await strategy(),
      archived = await strategy({ archived: true });
    const foreignClient = await strategy({ clientId: randomUUID() });
    const foreignTenant = await strategy({ tenantId: randomUUID() });
    const visible = await step(live);
    await step(live, undefined, { archived: true });
    await step(archived);
    await step(foreignClient);
    await step(foreignTenant);
    await step(live, undefined, { tenantId: randomUUID() });
    expect((await read('steps')).items.map((row) => row.id)).toEqual([visible]);
  });
  it('uses live Objective associations without duplication or stale revision values', async () => {
    const live = await objective(),
      removed = await objective(),
      deleted = await objective({ deleted: true });
    const unrelated = await objective(),
      foreign = await objective({ clientId: randomUUID() });
    await link(live.id);
    await link(live.id);
    await link(removed.id, { removed: true });
    await link(deleted.id);
    await link(unrelated.id, { target: randomUUID() });
    await link(foreign.id);
    expect((await read('objectives')).items).toEqual([
      {
        id: live.id,
        outcome: 'Saved outcome',
        status: 'ready',
        version: 3,
        askType: 'funding',
        minimumWin: 'Saved minimum win',
      },
    ]);
    await store.db.clientObjectiveResourceLink.updateMany({
      where: { objectiveId: live.id },
      data: { removedAt: new Date() },
    });
    expect((await read('objectives')).items).toEqual([]);
  });
  it.each(['steps', 'objectives'] as const)(
    'paginates all %s with a bounded stable cursor',
    async (section) => {
      const ids: string[] = [],
        s = await strategy();
      for (let i = 0; i < 27; i++) {
        if (section === 'steps') ids.push(await step(s));
        else {
          const o = await objective();
          ids.push(o.id);
          await link(o.id);
        }
      }
      const first = await read(section);
      expect(first.items).toHaveLength(25);
      expect(first.nextCursor).toBe(first.items[24]!.id);
      const second = await read(section, first.nextCursor!);
      expect(second.nextCursor).toBeNull();
      expect([...first.items, ...second.items].map((row) => row.id)).toEqual(ids.sort());
    },
  );
  it('current wall grants are required even for administrators; withdrawal refuses the next read', async () => {
    await store.db.client.update({ where: { id: clientId }, data: { memoryWall: true } });
    await expect(read('steps')).rejects.toMatchObject({ status: 404 });
    await store.db.clientMemoryAccess.create({
      data: { tenantId: ctx.tenantId, clientId, userId: ctx.userId, grantedBy: ctx.userId },
    });
    expect((await read('steps')).items).toEqual([]);
    await store.db.clientMemoryAccess.deleteMany({ where: { clientId } });
    await store.db.tenantMembership.updateMany({
      where: { tenantId: ctx.tenantId },
      data: { role: 'user_admin' },
    });
    ctx = { ...ctx, role: 'user_admin' };
    await expect(read('objectives')).rejects.toMatchObject({ status: 404 });
  });
  it.each(['membership', 'client', 'target', 'foreign-client'])(
    'refuses unavailable %s',
    async (kind) => {
      if (kind === 'membership')
        await store.db.tenantMembership.deleteMany({ where: { tenantId: ctx.tenantId } });
      if (kind === 'client')
        await store.db.client.update({ where: { id: clientId }, data: { status: 'archived' } });
      if (kind === 'target') await store.db.clientTarget.delete({ where: { id: targetId } });
      if (kind === 'foreign-client') clientId = randomUUID();
      await expect(read('steps')).rejects.toMatchObject({
        status: kind === 'membership' ? 403 : 404,
      });
    },
  );
  it('cannot create work or change the retained source when the drawer is read', async () => {
    const s = await strategy();
    await step(s);
    const o = await objective();
    await link(o.id);
    const snapshot = () => store.db
      .$queryRaw`SELECT (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM sp_node n) nodes,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM client_objectives o) objectives,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM client_objective_resource_links l) links`;
    const before = await snapshot();
    await read('steps');
    await read('objectives');
    expect(await snapshot()).toEqual(before);
  });
});
