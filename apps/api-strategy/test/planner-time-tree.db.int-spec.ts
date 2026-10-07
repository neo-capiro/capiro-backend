import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlannerService } from '../src/planner/planner.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import {
  PLANNER_DEFAULT_TASK,
  plannerTimeRollups,
  type PlannerTimeTreePage,
} from '@capiro/strategy-verifier';
const url = process.env.PLANNER_TEST_DATABASE_URL;
const tenantId = '10000000-0000-4000-8000-000000000039';
const otherTenantId = '10000000-0000-4000-8000-000000000040';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_tree_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_tree_owner', role: 'org:member' };
const stranger = { ...admin, clerkUserId: 'user_tree_stranger' };
(url ? describe : describe.skip)('Time trees under restricted PostgreSQL privileges', () => {
  let db: PrismaService, service: PlannerService;
  const scoped = <T>(
    id: string,
    run: (tx: Prisma.TransactionClient) => Promise<T>,
    opts?: Parameters<PrismaService['withTenant']>[2],
  ) =>
    db.withTenant(
      id,
      async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        return run(tx);
      },
      opts,
    );
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: url! } } });
    await db.$connect();
    for (const id of [tenantId, otherTenantId])
      await db.withTenant(id, async (tx) => {
        for (const ctx of [admin, owner, stranger]) {
          await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${randomUUID()}::uuid,${ctx.clerkUserId},${ctx.clerkUserId},${ctx.clerkUserId + '@example.test'}) ON CONFLICT DO NOTHING`;
          await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${id}::uuid,id,'active' FROM users WHERE clerk_user_id=${ctx.clerkUserId} AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${id}::uuid AND user_id=users.id)`;
        }
      });
    service = new PlannerService(
      { withTenant: scoped } as PrismaService,
      { validate: async () => undefined } as unknown as PlannerLinksService,
    );
  });
  afterAll(async () => db?.$disconnect());
  const project = async (ctx = admin, members = [{ userId: owner.clerkUserId, role: 'editor' }]) =>
    service.saveProject(ctx, null, {
      data: { name: 'Time tree QA ' + randomUUID(), privacy: 'private', members },
    });
  const task = async (
    projectId: string,
    estimateMinutes: number,
    parentId: string | null = null,
    ctx = admin,
  ) =>
    service.saveTask(ctx, null, {
      data: {
        name: 'Time tree task ' + randomUUID(),
        estimateMinutes,
        parentId,
        memberships: [{ projectId, sectionId: null, position: 0 }],
      },
    });
  const complete = async (ctx: AuthTenantContext, projectId: string) => {
    let page = await service.timeTree(ctx, { projectId });
    const pages: PlannerTimeTreePage[] = [page];
    while (page.nextCursor) {
      page = await service.timeTree(ctx, {
        projectId,
        cursor: page.nextCursor,
        revision: page.revision,
      });
      pages.push(page);
    }
    return {
      nodes: pages.flatMap((p) => p.nodes),
      revision: page.revision,
      matched: page.matched,
      pages,
    };
  };
  it('includes corrected/removed actual history, all levels and accessible descendants outside the source project', async () => {
    const p = await project(),
      outside = await project();
    const parent = await task(p.id, 60),
      child = await task(p.id, 30, parent.id),
      leaf = await task(outside.id, 15, child.id);
    await service.addEvent(
      owner,
      { taskId: parent.id },
      { kind: 'time', minutes: 60, text: 'Parent work' },
    );
    const entry = await service.addEvent(
      owner,
      { taskId: child.id },
      {
        kind: 'time',
        minutes: 45,
        text: 'Child work',
      },
    );
    await service.addEvent(
      owner,
      { taskId: leaf.id },
      { kind: 'time', minutes: 30, text: 'Leaf work' },
    );
    const first = await complete(owner, p.id);
    expect(first.nodes.find((n) => n.id === leaf.id)?.scoped).toBe(false);
    expect(plannerTimeRollups(first.nodes).values.get(parent.id)).toMatchObject({
      estimateMinutes: 105,
      actualMinutes: 135,
      descendantCount: 2,
    });
    await service.reviseEvent(owner, entry.id, { version: 0, text: 'Correction', minutes: 20 });
    const corrected = await complete(owner, p.id);
    expect(corrected.revision).not.toBe(first.revision);
    expect(plannerTimeRollups(corrected.nodes).values.get(parent.id)?.actualMinutes).toBe(110);
    await service.reviseEvent(owner, entry.id, { version: 1, removed: true });
    expect(
      plannerTimeRollups((await complete(owner, p.id)).nodes).values.get(parent.id)?.actualMinutes,
    ).toBe(90);
    expect((await service.task(owner, parent.id)).actualMinutes).toBe(60);
    const single = await service.timeTree(owner, { taskId: parent.id });
    expect(single.nodes.map((n) => n.id).sort()).toEqual([parent.id, child.id, leaf.id].sort());
    expect(plannerTimeRollups(single.nodes).values.get(parent.id)?.actualMinutes).toBe(90);
  });
  it('never includes a private bridge or its unscoped descendants, even for an unrelated org admin', async () => {
    const p = await project(),
      hidden = await project(admin, []),
      visibleLeaf = await project();
    const parent = await task(p.id, 60),
      bridge = await task(hidden.id, 300, parent.id),
      leaf = await task(visibleLeaf.id, 45, bridge.id);
    const page = await complete(owner, p.id);
    expect(page.nodes.map((n) => n.id)).toEqual([parent.id]);
    expect(plannerTimeRollups(page.nodes).values.get(parent.id)?.estimateMinutes).toBe(60);
    const leafPage = await complete(owner, visibleLeaf.id);
    expect(leafPage.nodes.find((n) => n.id === leaf.id)?.parentId).toBeNull();
    await expect(service.timeTree(stranger, { projectId: p.id })).rejects.toThrow('not found');
    await expect(service.timeTree(stranger, { taskId: parent.id })).rejects.toThrow('not found');
    await expect(service.timeTree(owner, { taskId: bridge.id })).rejects.toThrow('not found');
    await expect(
      service.timeTree({ ...owner, tenantId: otherTenantId }, { projectId: p.id }),
    ).rejects.toThrow('not found');
    const foreign = await scoped(otherTenantId, (tx) =>
      tx.spPlannerTask.findMany({
        where: { tenantId, id: { in: [parent.id, bridge.id, leaf.id] } },
      }),
    );
    expect(foreign).toEqual([]);
  });
  it('invalidates a captured page after a grant, estimate, correction or hierarchy change', async () => {
    const p = await project(),
      outside = await project();
    const parent = await task(p.id, 20),
      child = await task(outside.id, 10, parent.id);
    let page = await service.timeTree(owner, { projectId: p.id });
    await service.saveTask(admin, child.id, {
      version: child.version,
      data: { estimateMinutes: 11 },
    });
    await expect(
      service.timeTree(owner, { projectId: p.id, revision: page.revision }),
    ).rejects.toThrow('changed');
    page = await service.timeTree(owner, { projectId: p.id });
    await service.saveProject(admin, outside.id, {
      version: outside.version,
      data: { members: [] },
    });
    await expect(
      service.timeTree(owner, { projectId: p.id, revision: page.revision }),
    ).rejects.toThrow('changed');
    expect((await complete(owner, p.id)).nodes.map((n) => n.id)).toEqual([parent.id]);
  });
  it('loads all pages with one revision and includes descendants beyond the first task page', async () => {
    const p = await project(),
      parent = await task(p.id, 60);
    await scoped(tenantId, (tx) =>
      tx.spPlannerTask.createMany({
        data: Array.from({ length: 205 }, (_, i) => {
          const data = {
            ...PLANNER_DEFAULT_TASK,
            name: 'Paged child ' + i,
            estimateMinutes: 1,
            parentId: parent.id,
            memberships: [{ projectId: p.id, sectionId: null, position: i + 1 }],
          };
          return {
            tenantId,
            ownerId: admin.clerkUserId,
            parentId: parent.id,
            projectIds: [p.id],
            data: data as unknown as Prisma.InputJsonValue,
          };
        }),
      }),
    );
    const all = await complete(owner, p.id);
    expect(all.pages.map((page) => page.nodes.length)).toEqual([100, 100, 6]);
    expect(all.matched).toBe(206);
    expect(new Set(all.nodes.map((n) => n.id)).size).toBe(206);
    expect(new Set(all.pages.map((page) => page.revision)).size).toBe(1);
    expect(plannerTimeRollups(all.nodes).values.get(parent.id)?.estimateMinutes).toBe(265);
    const last = all.nodes.at(-1)!;
    await service.saveTask(admin, last.id, { version: last.version, data: { estimateMinutes: 2 } });
    await expect(
      service.timeTree(owner, {
        projectId: p.id,
        cursor: all.pages[0]!.nextCursor!,
        revision: all.revision,
      }),
    ).rejects.toThrow('changed');
  });
  it('keeps archived branches separate and personal source roots bound to the caller', async () => {
    const p = await project();
    const parent = await task(p.id, 20),
      child = await task(p.id, 10, parent.id),
      leaf = await task(p.id, 5, child.id);
    await service.saveTask(admin, child.id, { version: child.version, data: {}, archived: true });
    const all = await complete(owner, p.id);
    expect(all.nodes.find((n) => n.id === child.id)).toBeUndefined();
    expect(all.nodes.find((n) => n.id === leaf.id)?.parentId).toBeNull();
    expect(plannerTimeRollups(all.nodes).values.get(parent.id)?.estimateMinutes).toBe(20);
    const personal = await service.saveTask(owner, null, {
      data: { name: 'Personal parent', assigneeId: owner.clerkUserId, estimateMinutes: 10 },
    });
    const personalChild = await service.saveTask(owner, null, {
      data: { name: 'Personal child', parentId: personal.id, estimateMinutes: 5 },
    });
    const mine = await service.timeTree(owner, { mine: 'true' });
    expect(mine.nodes.find((n) => n.id === personal.id)?.scoped).toBe(true);
    expect(mine.nodes.find((n) => n.id === personalChild.id)?.scoped).toBe(false);
    expect(plannerTimeRollups(mine.nodes).values.get(personal.id)?.estimateMinutes).toBe(15);
    const archived = await service.timeTree(owner, { projectId: p.id, archived: 'true' });
    expect(archived.nodes.find((n) => n.id === child.id)?.scoped).toBe(true);
  });
  it('rejects invalid scopes and cursor/revision forgery without writes', async () => {
    const p = await project();
    await task(p.id, 5);
    for (const query of [
      { unknown: 'x' },
      { taskId: 'invalid' },
      { mine: 'yes' },
      { archived: 'yes' },
      { cursor: randomUUID() },
      { revision: 'bad' },
    ])
      await expect(service.timeTree(owner, query as never)).rejects.toThrow();
    const before = await complete(owner, p.id);
    await expect(
      service.timeTree(owner, { projectId: p.id, cursor: randomUUID(), revision: before.revision }),
    ).rejects.toThrow('cursor');
    expect(await complete(owner, p.id)).toEqual(before);
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id IN (SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
    );
    try {
      await expect(service.timeTree(owner, { projectId: p.id })).rejects.toThrow('not found');
    } finally {
      await db.withTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`,
      );
    }
  });
});
