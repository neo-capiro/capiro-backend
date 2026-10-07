import { randomUUID } from 'node:crypto';
import { PLANNER_DEFAULT_CAPACITY_PLAN, plannerCapacityMinutes } from '@capiro/strategy-verifier';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PlannerService } from '../src/planner/planner.service.js';
import { PlannerCapacityService } from '../src/planner/planner-capacity.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
const url = process.env.PLANNER_TEST_DATABASE_URL;
if (url && (new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/planner_qa'))
  throw Error('Capacity tests require dedicated localhost planner_qa');
const tenantId = '10000000-0000-4000-8000-000000000045';
const owner: AuthTenantContext = {
  tenantId,
  clerkUserId: 'user_capacity_owner',
  role: 'org:member',
};
const viewer = { ...owner, clerkUserId: 'user_capacity_viewer' },
  editor = { ...owner, clerkUserId: 'user_capacity_editor' },
  admin = { ...owner, clerkUserId: 'user_capacity_admin', role: 'org:admin' };
(url ? describe : describe.skip)('Shared capacity under restricted PostgreSQL privileges', () => {
  let db: PrismaService, work: PlannerService, capacity: PlannerCapacityService;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: url! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const ctx of [owner, viewer, editor, admin]) {
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${randomUUID()}::uuid,${ctx.clerkUserId},${ctx.clerkUserId},${ctx.clerkUserId + '@example.test'}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${tenantId}::uuid,id,'active' FROM users WHERE clerk_user_id=${ctx.clerkUserId} AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenantId}::uuid AND user_id=users.id)`;
      }
      await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
    });
    const prisma = {
      withTenant: <T>(
        id: string,
        run: (tx: Prisma.TransactionClient) => Promise<T>,
        options?: Parameters<PrismaService['withTenant']>[2],
      ) =>
        db.withTenant(
          id,
          async (tx) => {
            await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
            return run(tx);
          },
          options,
        ),
    } as PrismaService;
    work = new PlannerService(prisma, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
    capacity = new PlannerCapacityService(prisma);
  });
  afterAll(async () => db?.$disconnect());
  beforeEach(async () => {
    await db.withTenant(tenantId, async (tx) => {
      await tx.spPlannerProject.updateMany({
        where: { tenantId, archived: false },
        data: { archived: true },
      });
      await tx.spPlannerResource.updateMany({
        where: { tenantId, kind: { startsWith: 'capacity_' } },
        data: { archived: true },
      });
    });
  });
  const project = (
    members = [
      { userId: viewer.clerkUserId, role: 'viewer' },
      { userId: editor.clerkUserId, role: 'editor' },
    ],
  ) =>
    work.saveProject(owner, null, {
      data: { name: 'Capacity project ' + randomUUID(), privacy: 'private', members },
    });
  const plan = (projectIds: string[], patch = {}) =>
    capacity.saveRecord(owner, 'capacity_plan', {
      id: randomUUID(),
      name: 'Capacity plan ' + randomUUID(),
      data: { ...PLANNER_DEFAULT_CAPACITY_PLAN, projectIds, ...patch },
    });
  const allocation = (projectId: string, patch = {}) => ({
    id: randomUUID(),
    projectId,
    data: {
      userId: owner.clerkUserId,
      placeholderId: null,
      startOn: '2026-12-21',
      endOn: '2026-12-25',
      effort: { unit: 'percent', value: 50 },
      ...patch,
    },
  });
  const save = (p: any, changes: any[], ctx = owner) =>
    capacity.saveAllocations(ctx, { planId: p.id, planVersion: p.version, changes });
  it('runs as non-bypass capiro_app, shares allocations across plans, and creates no tasks/events/inbox', async () => {
    const p = await project(),
      one = await plan([p.id]),
      two = await plan([p.id]);
    const before = await db.withTenant(tenantId, async (tx) =>
      Promise.all([
        tx.spPlannerTask.count({ where: { tenantId } }),
        tx.spPlannerEvent.count({ where: { tenantId } }),
        tx.spPlannerInbox.count({ where: { tenantId } }),
      ]),
    );
    const saved = await save(one, [allocation(p.id)]);
    expect((await capacity.plan(owner, two.id)).allocations.map((a) => a.id)).toContain(
      saved.allocations[0]!.id,
    );
    expect(plannerCapacityMinutes(saved.allocations[0]!)).toBe(1200);
    const after = await db.withTenant(tenantId, async (tx) =>
      Promise.all([
        tx.spPlannerTask.count({ where: { tenantId } }),
        tx.spPlannerEvent.count({ where: { tenantId } }),
        tx.spPlannerInbox.count({ where: { tenantId } }),
      ]),
    );
    expect(after).toEqual(before);
    expect((await work.resources(owner)).some((r) => r.id === one.id)).toBe(false);
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      expect(
        await tx.$queryRaw`SELECT current_user AS role,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`,
      ).toEqual([{ role: 'capiro_app', rolsuper: false, rolbypassrls: false }]);
    });
  });
  it('intersects plan sharing with source-project grants, including unrelated org admins', async () => {
    const p = await project(),
      privateP = await project([]),
      shared = await plan([p.id, privateP.id], {
        privacy: 'team',
        members: [
          { userId: editor.clerkUserId, role: 'admin' },
          { userId: admin.clerkUserId, role: 'admin' },
        ],
      });
    await save(shared, [allocation(p.id), allocation(privateP.id)]);
    expect((await capacity.plan(viewer, shared.id)).allocations).toHaveLength(1);
    expect((await capacity.plan(admin, shared.id)).allocations).toHaveLength(0);
    expect((await capacity.plan(admin, shared.id)).plan.data.projectIds).toEqual([]);
    await expect(save(shared, [allocation(p.id)], viewer)).rejects.toThrow('admin');
    await expect(save(shared, [allocation(privateP.id)], editor)).rejects.toThrow('unavailable');
    const readable = await capacity.plan(viewer, shared.id);
    const a = readable.allocations[0]!;
    const viewerAdminPlan = await plan([p.id], {
      members: [{ userId: viewer.clerkUserId, role: 'admin' }],
    });
    await expect(
      save(viewerAdminPlan, [{ id: a.id, version: a.version, shiftDays: 7 }], viewer),
    ).rejects.toThrow('editor');
  });
  it('includes live portfolio additions and people selections without widening private access', async () => {
    const one = await project(),
      two = await project();
    let portfolio = await work.saveResource(owner, null, {
      kind: 'portfolio',
      name: 'Capacity portfolio',
      data: { privacy: 'private', members: [], description: '', projectIds: [one.id] },
    });
    const p = await plan([], { portfolioIds: [portfolio.id] });
    await save(p, [allocation(one.id)]);
    await expect(save(p, [allocation(two.id)])).rejects.toThrow('Add the project');
    portfolio = await work.saveResource(owner, portfolio.id, {
      version: portfolio.version,
      data: { projectIds: [one.id, two.id] },
    });
    await save(p, [allocation(two.id)]);
    expect((await capacity.plan(owner, p.id)).projectIds.sort()).toEqual([one.id, two.id].sort());
    const personPlan = await plan([], { peopleIds: [owner.clerkUserId] });
    expect((await capacity.plan(owner, personPlan.id)).allocations.length).toBeGreaterThanOrEqual(
      2,
    );
  });
  it('supports team-scoped placeholders, transfer, duplicate, move, archive and restore', async () => {
    const p = await project();
    const team = await capacity.saveRecord(owner, 'capacity_team', {
      id: randomUUID(),
      name: 'Planner engineering',
      data: {
        privacy: 'private',
        members: [],
        peopleIds: [owner.clerkUserId],
        jobTitles: { [owner.clerkUserId]: 'Engineer' },
      },
    });
    const placeholder = await capacity.saveRecord(owner, 'capacity_placeholder', {
      id: randomUUID(),
      name: 'Open designer',
      data: { teamId: team.id, jobTitle: 'Designer', weeklyMinutes: 1800 },
    });
    const cp = await plan([p.id], { teamIds: [team.id], privacy: 'team' });
    const first = (
      await save(cp, [allocation(p.id, { userId: null, placeholderId: placeholder.id })])
    ).allocations[0]!;
    expect(plannerCapacityMinutes(first)).toBe(900);
    expect((await capacity.plan(viewer, cp.id)).allocations).toEqual([]);
    await expect(
      save(cp, [allocation(p.id, { userId: null, placeholderId: placeholder.id })], viewer),
    ).rejects.toThrow();
    const duplicate = (
      await save(cp, [
        { id: first.id, version: first.version, duplicateId: randomUUID(), shiftDays: 7 },
      ])
    ).allocations[0]!;
    expect(duplicate.data.startOn).toBe('2026-12-28');
    let moved = (
      await save(cp, [
        {
          id: duplicate.id,
          version: duplicate.version,
          data: { userId: owner.clerkUserId, placeholderId: null },
          shiftDays: -7,
        },
      ])
    ).allocations[0]!;
    expect(moved.jobTitle).toBe('Engineer');
    expect(moved.data.placeholderId).toBeNull();
    moved = (await save(cp, [{ id: moved.id, version: moved.version, archived: true }]))
      .allocations[0]!;
    expect((await capacity.plan(owner, cp.id)).allocations).toHaveLength(1);
    expect((await capacity.plan(owner, cp.id, { archived: 'true' })).allocations).toHaveLength(1);
    await save(cp, [{ id: moved.id, version: moved.version, archived: false }]);
    expect((await capacity.plan(owner, cp.id)).allocations).toHaveLength(2);
  });
  it('rejects an entire bulk change before writing and serializes stale concurrent edits', async () => {
    const p = await project(),
      cp = await plan([p.id]);
    const a = (await save(cp, [allocation(p.id)])).allocations[0]!;
    await expect(
      save(cp, [
        { id: a.id, version: a.version, shiftDays: 7 },
        { ...allocation(p.id), data: { ...a.data, userId: 'inactive' } },
      ]),
    ).rejects.toThrow('active');
    expect((await capacity.plan(owner, cp.id)).allocations[0]!.version).toBe(a.version);
    const attempts = await Promise.allSettled([
      save(cp, [{ id: a.id, version: a.version, shiftDays: 7 }]),
      save(cp, [{ id: a.id, version: a.version, shiftDays: -7 }]),
    ]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
  it('paginates all allocations under a qualified revision and detects changes on later pages', async () => {
    const p = await project(),
      cp = await plan([p.id]);
    for (const count of [100, 100, 5])
      await save(
        cp,
        Array.from({ length: count }, () => allocation(p.id)),
      );
    const first = await capacity.plan(owner, cp.id);
    expect(first.matched).toBe(205);
    expect(first.allocations).toHaveLength(100);
    const second = await capacity.plan(owner, cp.id, {
      cursor: first.nextCursor!,
      revision: first.revision,
    });
    const last = await capacity.plan(owner, cp.id, {
      cursor: second.nextCursor!,
      revision: first.revision,
    });
    expect(last.allocations).toHaveLength(5);
    expect(last.nextCursor).toBeNull();
    const a = last.allocations[0]!;
    await save(cp, [{ id: a.id, version: a.version, shiftDays: 7 }]);
    await expect(
      capacity.plan(owner, cp.id, { cursor: first.nextCursor!, revision: first.revision }),
    ).rejects.toThrow('changed');
  });
  it('rechecks revoked project grants and preserves hidden selectors during plan-admin edits', async () => {
    const p = await project(),
      cp = await plan([p.id], { members: [{ userId: editor.clerkUserId, role: 'admin' }] });
    await save(cp, [allocation(p.id)]);
    const before = await capacity.plan(editor, cp.id);
    await work.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(capacity.plan(editor, cp.id, { revision: before.revision })).rejects.toThrow(
      'changed',
    );
    const redacted = await capacity.plan(editor, cp.id);
    expect(redacted.plan.data.projectIds).toEqual([]);
    expect(redacted.allocations).toEqual([]);
    await capacity.saveRecord(editor, 'capacity_plan', {
      id: cp.id,
      version: cp.version,
      name: 'Renamed',
      data: redacted.plan.data,
    });
    expect((await capacity.plan(owner, cp.id)).plan.data.projectIds).toEqual([p.id]);
  });
  it('blocks cross-tenant ids, generic-resource writes and inactive membership', async () => {
    const p = await project(),
      cp = await plan([p.id]);
    await expect(
      capacity.plan({ ...owner, tenantId: '10000000-0000-4000-8000-000000000046' }, cp.id),
    ).rejects.toThrow('unavailable');
    await expect(
      work.saveResource(owner, cp.id, { version: cp.version, name: 'Forged' }),
    ).rejects.toThrow('not found');
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id IN(SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
    );
    try {
      await expect(capacity.catalog(owner)).rejects.toThrow('unavailable');
      await expect(save(cp, [allocation(p.id)])).rejects.toThrow('unavailable');
    } finally {
      await db.withTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`,
      );
    }
  });
});
