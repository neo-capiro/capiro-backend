import { randomUUID } from 'node:crypto';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import { PLANNER_DEFAULT_MY_TASKS, PLANNER_DEFAULT_TASK } from '@capiro/strategy-verifier';
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Planner DB tests require the dedicated localhost planner_qa database');
}
const describeDb = testUrl ? describe : describe.skip;
describeDb('Planner reminder and bell real PostgreSQL', () => {
  let prisma: PrismaService, service: PlannerService;
  const tenantId = '10000000-0000-4000-8000-000000000009';
  const owner: AuthTenantContext = {
    tenantId,
    clerkUserId: 'user_schedule_owner',
    role: 'org:admin',
  };
  const viewer = { ...owner, clerkUserId: 'user_schedule_viewer', role: 'org:member' };
  const now = new Date('2042-11-01T16:00:00Z');
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await prisma.$connect();
    service = new PlannerService(prisma, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
    await prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO users(id, clerk_user_id, first_name, last_name, email) VALUES
        ('90000000-0000-4000-8000-000000000009'::uuid, 'user_schedule_owner', 'Schedule', 'Owner', 'schedule-owner@example.test'),
        ('90000000-0000-4000-8000-000000000010'::uuid, 'user_schedule_viewer', 'Schedule', 'Viewer', 'schedule-viewer@example.test') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status)
        SELECT ${tenantId}::uuid,u.id,'active' FROM users u WHERE u.clerk_user_id IN ('user_schedule_owner','user_schedule_viewer')
        AND NOT EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=${tenantId}::uuid AND m.user_id=u.id)`;
    });
  });
  beforeEach(async () => {
    await prisma.withTenant(tenantId, async (tx) => {
      await tx.spPlannerTask.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.spPlannerResource.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.spPlannerInbox.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
    });
  });
  afterAll(async () => prisma?.$disconnect());
  async function dueTask(projectId?: string) {
    return service.saveTask(owner, null, {
      data: {
        name: 'Scheduled synthetic task',
        assigneeId: owner.clerkUserId,
        dueOn: '2042-11-02',
        timeZone: 'America/New_York',
        ...(projectId ? { memberships: [{ projectId, sectionId: null, position: 0 }] } : {}),
      },
    });
  }
  async function personal() {
    return service.saveResource(owner, null, {
      kind: 'my_tasks',
      name: 'Private date rules',
      data: {
        ...PLANNER_DEFAULT_MY_TASKS,
        rules: [
          {
            id: randomUUID(),
            name: 'Due tomorrow',
            enabled: true,
            trigger: 'due_approaching',
            schedule: { amount: 1, unit: 'days' },
            sectionId: PLANNER_DEFAULT_MY_TASKS.sections[0]!.id,
            notify: true,
          },
        ],
      },
    });
  }
  it('shares corrected activity and a full authorized unread total while filtering revoked rows before LIMIT', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Authorized project',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
      },
    });
    const t = await dueTask(p.id);
    await prisma.withTenant(tenantId, (tx) =>
      tx.spPlannerInbox.updateMany({
        where: { tenantId, userId: viewer.clerkUserId },
        data: { archived: true },
      }),
    );
    await prisma.withTenant(tenantId, async (tx) => {
      const ids = Array.from({ length: 125 }, () => randomUUID());
      await tx.spPlannerEvent.createMany({
        data: ids.map((id) => ({
          id,
          tenantId,
          taskId: t.id,
          actorId: owner.clerkUserId,
          kind: 'comment',
          text: 'Authorized comment',
        })),
      });
      await tx.spPlannerInbox.createMany({
        data: ids.map((eventId) => ({ tenantId, eventId, userId: viewer.clerkUserId })),
      });
    });
    const hidden = await service.saveProject(owner, null, {
      data: {
        name: 'Revoked private project',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
      },
    });
    const event = await service.addEvent(
      owner,
      { projectId: hidden.id },
      { kind: 'comment', text: 'Revoked secret' },
    );
    await service.saveProject(owner, hidden.id, { version: hidden.version, data: { members: [] } });
    const bell = await service.notifications(viewer);
    expect(bell.unread).toBe(125);
    expect(bell.items).toHaveLength(100);
    expect(
      bell.items.every((i) => i.title === t.name && i.event.text === 'Authorized comment'),
    ).toBe(true);
    const first = bell.items[0]!;
    await service.reviseEvent(owner, first.event.id, {
      version: 0,
      text: 'Corrected bell comment',
    });
    expect(
      (await service.notifications(viewer)).items.find((i) => i.id === first.id)?.event.text,
    ).toBe('Corrected bell comment');
    await service.updateInbox(viewer, first.id, { read: true });
    expect((await service.notifications(viewer)).unread).toBe(124);
    expect(await service.readAllNotifications(viewer)).toEqual({ read: 124 });
    expect((await service.notifications(viewer)).unread).toBe(0);
    const revoked = await prisma.withTenant(tenantId, (tx) =>
      tx.spPlannerInbox.findFirst({
        where: { tenantId, eventId: event.id, userId: viewer.clerkUserId },
      }),
    );
    expect(revoked?.read).toBe(false);
    await expect(service.updateInbox(viewer, revoked!.id, { read: true })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.updateInbox(owner, first.id, { read: true })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('atomically moves private placement and reminds the configuring user once across simultaneous workers and later saves', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: 'Shared placement unchanged' },
    });
    const t = await dueTask(p.id);
    await personal();
    const results = await Promise.all([
      service.runScheduledWork(tenantId, now),
      service.runScheduledWork(tenantId, now),
    ]);
    expect(results.reduce((n, r) => n + r.executed, 0)).toBe(1);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    const untouched = await service.task(owner, t.id);
    expect(untouched.version).toBe(t.version);
    expect(untouched.memberships).toEqual(t.memberships);
    const settings = (await service.resources(owner)).find(
      (r) => r.kind === 'my_tasks' && !r.archived,
    )!;
    expect(settings.data.placements).toEqual([
      { taskId: t.id, sectionId: PLANNER_DEFAULT_MY_TASKS.sections[0]!.id, position: 0 },
    ]);
    expect((await service.notifications(owner)).items).toHaveLength(1);
    expect((await service.notifications(viewer)).unread).toBe(0);
    await service.saveResource(owner, settings.id, {
      version: settings.version,
      name: 'Renamed settings',
      data: { placements: [{ taskId: t.id, sectionId: null, position: 7 }] },
    });
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(0);
    expect(
      (await service.resources(owner)).find((r) => r.id === settings.id)?.data.placements,
    ).toEqual([{ taskId: t.id, sectionId: null, position: 7 }]);
    const inbox = (await service.notifications(owner)).items[0]!;
    await service.updateInbox(owner, inbox.id, { read: true });
    expect((await service.notifications(owner)).unread).toBe(0);
    expect((await service.inbox(owner)).find((i) => i.id === inbox.id)?.read).toBe(true);
  });
  it('runs project overdue actions on top-level tasks and stops for paused rules or revoked authors', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Scheduled actions',
        members: [{ userId: viewer.clerkUserId, role: 'editor' }],
      },
    });
    const t = await dueTask(p.id);
    const child = await service.saveTask(owner, null, {
      data: {
        name: 'Skipped scheduled subtask',
        parentId: t.id,
        dueOn: t.dueOn,
        assigneeId: owner.clerkUserId,
      },
    });
    const rule = await service.saveResource(viewer, null, {
      kind: 'rule',
      projectId: p.id,
      name: 'Overdue escalation',
      data: {
        enabled: true,
        trigger: 'overdue',
        schedule: { amount: 0, unit: 'days' },
        conditions: {},
        actions: { priority: 'high', notify: true },
      },
    });
    const later = new Date('2042-11-03T12:00:00Z');
    expect((await service.runScheduledWork(tenantId, later)).executed).toBe(1);
    expect((await service.task(owner, t.id)).priority).toBe('high');
    expect((await service.task(owner, child.id)).priority).toBe('none');
    const next = await dueTask(p.id);
    const paused = await service.saveResource(viewer, rule.id, {
      version: rule.version,
      data: { enabled: false },
    });
    expect((await service.runScheduledWork(tenantId, later)).executed).toBe(0);
    await service.saveResource(viewer, paused.id, {
      version: paused.version,
      data: { enabled: true },
    });
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    expect((await service.runScheduledWork(tenantId, later)).executed).toBe(0);
    expect((await service.task(owner, next.id)).priority).toBe('none');
  });
  it('rearms on a changed due schedule, excludes reassigned/completed work and ignores inactive authors', async () => {
    const t = await dueTask();
    await personal();
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(1);
    let changed = await service.saveTask(owner, t.id, {
      version: t.version,
      data: { dueOn: '2042-11-01' },
    });
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(1);
    changed = await service.saveTask(owner, changed.id, {
      version: changed.version,
      data: { assigneeId: viewer.clerkUserId },
    });
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(0);
    const done = await dueTask();
    await service.saveTask(owner, done.id, { version: done.version, data: { status: 'done' } });
    await dueTask();
    await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id='90000000-0000-4000-8000-000000000009'::uuid`,
    );
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(0);
  });
  it('scheduled completion shares recurrence behavior and rolls back its claim if a descendant is inaccessible', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Recurring scheduled completion',
        members: [{ userId: viewer.clerkUserId, role: 'editor' }],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Recurring scheduled root',
        dueOn: '2042-11-02',
        recurrence: { frequency: 'daily', interval: 1 },
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const child = await service.saveTask(owner, null, {
      data: { name: 'Hidden child', parentId: t.id },
    });
    const hidden = await service.saveProject(owner, null, {
      data: { name: 'Hidden descendant project' },
    });
    await service.saveTask(owner, child.id, {
      version: child.version,
      data: { memberships: [{ projectId: hidden.id, sectionId: null, position: 0 }] },
    });
    await service.saveResource(viewer, null, {
      kind: 'rule',
      name: 'Finish overdue work',
      projectId: p.id,
      data: {
        enabled: true,
        trigger: 'overdue',
        schedule: { amount: 0, unit: 'days' },
        conditions: {},
        actions: { status: 'done' },
      },
    });
    const later = new Date('2042-11-03T12:00:00Z');
    expect((await service.runScheduledWork(tenantId, later)).failed).toBe(1);
    expect((await service.task(owner, t.id)).status).toBe('todo');
    expect(
      await prisma.withTenant(tenantId, (tx) =>
        tx.spPlannerScheduleClaim.count({ where: { tenantId, taskId: t.id } }),
      ),
    ).toBe(0);
    await service.saveProject(owner, hidden.id, {
      version: hidden.version,
      data: { members: [{ userId: viewer.clerkUserId, role: 'viewer' }] },
    });
    expect((await service.runScheduledWork(tenantId, later)).executed).toBe(1);
    expect((await service.task(owner, t.id)).status).toBe('done');
    const tasks = (await service.tasks(owner, { projectId: p.id })).items;
    expect(tasks.filter((x) => x.name === t.name)).toHaveLength(2);
    expect((await service.runScheduledWork(tenantId, later)).executed).toBe(0);
  });
  it('claims are immutable, tenant-bound, and readable only through the restricted runtime role in its tenant', async () => {
    const t = await dueTask();
    const resource = await personal();
    await service.runScheduledWork(tenantId, now);
    await prisma.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const rows = await tx.spPlannerScheduleClaim.findMany({ where: { tenantId, taskId: t.id } });
      expect(rows).toHaveLength(1);
      const rights = await tx.$queryRaw<
        { insert: boolean; update: boolean; delete: boolean }[]
      >`SELECT
        has_table_privilege(current_user,'sp_planner_schedule_claims','INSERT') AS insert,
        has_table_privilege(current_user,'sp_planner_schedule_claims','UPDATE') AS update,
        has_table_privilege(current_user,'sp_planner_schedule_claims','DELETE') AS delete`;
      expect(rights[0]).toEqual({ insert: true, update: false, delete: false });
      const inserted = await tx.spPlannerScheduleClaim.create({
        data: {
          tenantId,
          resourceId: resource.id,
          taskId: t.id,
          fingerprint: 'a'.repeat(64),
          deadlineKey: 'a'.repeat(64),
        },
      });
      expect(inserted.tenantId).toBe(tenantId);
    });
    await prisma.withTenant('10000000-0000-4000-8000-000000000002', async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      expect(
        await tx.$queryRaw`SELECT * FROM sp_planner_schedule_claims WHERE task_id=${t.id}::uuid`,
      ).toEqual([]);
    });
    await expect(
      prisma.withTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE sp_planner_schedule_claims SET deadline_key=repeat('a',64) WHERE task_id=${t.id}::uuid`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.withTenant('10000000-0000-4000-8000-000000000002', (tx) =>
        tx.spPlannerScheduleClaim.create({
          data: {
            tenantId: '10000000-0000-4000-8000-000000000002',
            resourceId: resource.id,
            taskId: t.id,
            fingerprint: 'a'.repeat(64),
            deadlineKey: 'b'.repeat(64),
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('excludes inactive reminder recipients and removes them from the next recurring occurrence', async () => {
    const p = await service.saveProject(owner, null, { data: { name: 'Inactive recipient' } });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Inactive assigned repeat',
        assigneeId: viewer.clerkUserId,
        dueOn: '2042-11-02',
        recurrence: { frequency: 'daily', interval: 1 },
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    await service.saveResource(owner, null, {
      kind: 'rule',
      projectId: p.id,
      name: 'Complete approaching work',
      data: {
        enabled: true,
        trigger: 'due_approaching',
        schedule: { amount: 1, unit: 'days' },
        conditions: {},
        actions: { status: 'done', notify: true },
      },
    });
    await prisma.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id='90000000-0000-4000-8000-000000000010'::uuid`,
    );
    expect((await service.runScheduledWork(tenantId, now)).executed).toBe(1);
    const next = (await service.tasks(owner, { projectId: p.id })).items.find(
      (task) => task.id !== t.id,
    )!;
    expect(next.assigneeId).toBeNull();
    const inbox = await prisma.withTenant(tenantId, (tx) =>
      tx.spPlannerInbox.findMany({
        where: { tenantId, userId: viewer.clerkUserId, archived: false },
        include: { event: true },
      }),
    );
    expect(inbox.filter((row) => row.event.kind === 'reminder')).toHaveLength(0);
  });
});
