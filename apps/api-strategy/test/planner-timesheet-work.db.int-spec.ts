import { randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeWorkKey,
  plannerWeekDate,
  plannerWeekOn,
} from '@capiro/strategy-verifier';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const u = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname != '/planner_qa')
    throw Error('Weekly work tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000032';
const admin: AuthTenantContext = {
  tenantId,
  clerkUserId: 'user_weekly_work_admin',
  role: 'org:admin',
};
const owner: AuthTenantContext = {
  ...admin,
  clerkUserId: 'user_weekly_work_owner',
  role: 'org:member',
};
const reviewer = { ...owner, clerkUserId: 'user_weekly_work_reviewer' };
const weekBase = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
let index = 0;
describeDb('Timesheet work selections and prepopulation under forced row security', () => {
  let db: PrismaService, service: PlannerService, week: string;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const [id, subject] of [
        ['95000000-0000-4000-8000-000000000001', admin.clerkUserId],
        ['95000000-0000-4000-8000-000000000002', owner.clerkUserId],
        ['95000000-0000-4000-8000-000000000003', reviewer.clerkUserId],
      ]) {
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${id}::uuid,${subject},${subject},${subject + '@example.test'}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${tenantId}::uuid,${id}::uuid,'active' WHERE NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenantId}::uuid AND user_id=${id}::uuid)`;
      }
    });
    const runtime = {
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
    service = new PlannerService(runtime, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
  });
  const preference = async (enabled: boolean) => {
    const current = await service.timePreferences(owner);
    await service.saveTimePreferences(owner, {
      version: current.version,
      autoAddDueTasks: enabled,
    });
  };
  beforeEach(async () => {
    week = plannerWeekDate(weekBase, 14 * index++);
    const config = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: config.version,
      reviewers: { [owner.clerkUserId]: reviewer.clerkUserId },
      options: PLANNER_DEFAULT_TIME_OPTIONS,
    });
    await preference(false);
  });
  afterAll(async () => db?.$disconnect());
  const project = (share = true) =>
    service.saveProject(owner, null, {
      data: {
        name: 'Synthetic weekly work ' + randomUUID(),
        privacy: 'private',
        members: share ? [{ userId: reviewer.clerkUserId, role: 'editor' }] : [],
      },
    });
  const task = (
    projectId: string,
    name = 'Weekly task',
    dueOn = week,
    assigneeId: string | null = owner.clerkUserId,
  ) =>
    service.saveTask(owner, null, {
      data: { name, dueOn, assigneeId, memberships: [{ projectId, sectionId: null, position: 0 }] },
    });
  const select = async (
    action: 'add' | 'remove',
    work: { taskId: string | null; projectId: string | null },
    ctx = owner,
  ) => {
    const sheet = await service.timesheet(ctx, { week, userId: owner.clerkUserId });
    return service.saveTimesheetWork(ctx, {
      week,
      userId: owner.clerkUserId,
      version: sheet.version,
      revision: sheet.revision,
      action,
      work,
    });
  };
  const log = (taskId: string) =>
    service.addEvent(
      owner,
      { taskId },
      { kind: 'time', minutes: 30, text: 'Synthetic weekly time', time: { workedOn: week } },
    );
  it('keeps preferences owner-only, versioned, unique and outside generic resources', async () => {
    const opening = await service.timePreferences(owner);
    await preference(true);
    await expect(
      service.saveTimePreferences(owner, { version: opening.version, autoAddDueTasks: false }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveTimePreferences(reviewer, {
        version: 0,
        autoAddDueTasks: true,
        userId: owner.clerkUserId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await service.timePreferences(reviewer)).autoAddDueTasks).toBe(false);
    expect(
      (await service.resources(owner)).some((r) => r.name === 'Personal timesheet settings'),
    ).toBe(false);
    await expect(
      db.withTenant(tenantId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.spPlannerResource.create({
          data: {
            tenantId,
            ownerId: owner.clerkUserId,
            kind: 'time_preferences',
            name: 'Duplicate',
            data: {},
          },
        });
      }),
    ).rejects.toThrow();
    await expect(
      service.timePreferences({ ...owner, tenantId: '10000000-0000-4000-8000-000000003232' }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('prepopulates assigned tasks on both week boundaries without creating events or time', async () => {
    const p = await project();
    const monday = await task(p.id, 'Monday'),
      sunday = await task(p.id, 'Sunday', plannerWeekDate(week, 6));
    await task(p.id, 'Next week', plannerWeekDate(week, 7));
    await task(p.id, 'Prior week', plannerWeekDate(week, -1));
    await task(p.id, 'Other submitter', week, reviewer.clerkUserId);
    const archived = await task(p.id, 'Archived');
    await service.saveTask(owner, archived.id, { version: archived.version, archived: true });
    await preference(true);
    const sheet = await service.timesheet(owner, { week });
    expect(sheet.workRows?.map((r) => r.taskId).sort()).toEqual([monday.id, sunday.id].sort());
    expect(
      sheet.workRows?.every((r) => r.origin === 'automatic' && r.totalMinutes === 0 && r.canRemove),
    ).toBe(true);
    expect(sheet.totalMinutes).toBe(0);
    expect(sheet.items).toEqual([]);
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      expect(
        await tx.spPlannerEvent.count({
          where: { tenantId, kind: 'time', taskId: { in: [monday.id, sunday.id] } },
        }),
      ).toBe(0);
    });
  });
  it('persists manual zero-hour selections through submission and recall without changing task assignment', async () => {
    const p = await project(),
      t = await task(p.id, 'Manual', plannerWeekDate(week, 10));
    await select('add', { taskId: t.id, projectId: p.id });
    await select('add', { taskId: null, projectId: p.id });
    let view = await service.timesheet(owner, { week });
    expect(view.workRows).toHaveLength(2);
    expect(view.totalMinutes).toBe(0);
    expect((await service.task(owner, t.id)).assigneeId).toBe(owner.clerkUserId);
    await log(t.id);
    view = await service.timesheet(owner, { week });
    await service.transitionTimesheet(owner, {
      week,
      userId: owner.clerkUserId,
      version: view.version,
      revision: view.revision,
      action: 'submit',
      notes: '',
    });
    await expect(select('remove', { taskId: null, projectId: p.id })).rejects.toMatchObject({
      status: 403,
    });
    view = await service.timesheet(owner, { week });
    await service.transitionTimesheet(owner, {
      week,
      userId: owner.clerkUserId,
      version: view.version,
      revision: view.revision,
      action: 'recall_submission',
      notes: '',
    });
    expect((await service.timesheet(owner, { week })).workRows).toHaveLength(2);
  });
  it('removes and restores an automatic placeholder for just its selected week', async () => {
    const p = await project(),
      t = await task(p.id);
    await preference(true);
    await select('remove', { taskId: t.id, projectId: p.id });
    expect((await service.timesheet(owner, { week })).matchedWork).toBe(0);
    await preference(false);
    await preference(true);
    expect((await service.timesheet(owner, { week })).matchedWork).toBe(0);
    await select('add', { taskId: t.id, projectId: p.id });
    expect((await service.timesheet(owner, { week })).workRows?.[0]?.origin).toBe('added');
    const moved = await service.saveTask(owner, t.id, {
      version: t.version,
      data: { dueOn: plannerWeekDate(week, 7) },
    });
    expect(
      (await service.timesheet(owner, { week: plannerWeekDate(week, 7) })).workRows?.some(
        (r) => r.taskId === moved.id,
      ),
    ).toBe(true);
  });
  it('requires current source permissions for reviewer rows and rejects unrelated admin access', async () => {
    const p = await project(),
      t = await task(p.id);
    await preference(true);
    expect(
      (await service.timesheet(reviewer, { week, userId: owner.clerkUserId })).workRows?.some(
        (r) => r.taskId === t.id,
      ),
    ).toBe(true);
    const old = await service.timesheet(reviewer, { week, userId: owner.clerkUserId });
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(
      service.timesheet(reviewer, { week, userId: owner.clerkUserId, revision: old.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const hidden = await service.timesheet(reviewer, { week, userId: owner.clerkUserId });
    expect(hidden.workRows).toEqual([]);
    await expect(select('add', { taskId: t.id, projectId: p.id }, reviewer)).rejects.toMatchObject({
      status: 404,
    });
    await expect(select('add', { taskId: t.id, projectId: p.id }, admin)).rejects.toMatchObject({
      status: 404,
    });
  });
  it('pages all 121 work rows and refuses removing logged work beyond the first page', async () => {
    const p = await project();
    const ids = Array.from({ length: 121 }, () => randomUUID());
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.spPlannerTask.createMany({
        data: ids.map((id, i) => ({
          id,
          tenantId,
          ownerId: owner.clerkUserId,
          assigneeId: owner.clerkUserId,
          projectIds: [p.id],
          data: {
            ...PLANNER_DEFAULT_TASK,
            name: 'Work ' + String(i).padStart(3, '0'),
            assigneeId: owner.clerkUserId,
            dueOn: week,
            memberships: [{ projectId: p.id, sectionId: null, position: i }],
          } as Prisma.InputJsonValue,
        })),
      });
    });
    await preference(true);
    const first = await service.timesheet(owner, { week });
    expect(first.matchedWork).toBe(121);
    expect(first.workRows).toHaveLength(100);
    const next = await service.timesheet(owner, {
      week,
      workCursor: first.nextWorkCursor!,
      revision: first.revision,
    });
    expect(next.workRows).toHaveLength(21);
    expect(next.nextWorkCursor).toBeNull();
    const event = await log(ids[120]!);
    const active = await service.timesheet(owner, { week });
    expect(active.totalMinutes).toBe(30);
    expect(active.workRows?.some((r) => r.taskId === ids[120])).toBe(false);
    await expect(select('remove', { taskId: ids[120]!, projectId: p.id })).rejects.toMatchObject({
      status: 403,
    });
    await service.reviseEvent(owner, event.id, { version: 0, removed: true });
    await select('remove', { taskId: ids[120]!, projectId: p.id });
    expect((await service.timesheet(owner, { week })).matchedWork).toBe(120);
    await expect(
      service.timesheet(owner, {
        week,
        workCursor: first.nextWorkCursor!,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects stale concurrent work selections and keeps one successful row', async () => {
    const p = await project(),
      t = await task(p.id);
    const sheet = await service.timesheet(owner, { week });
    const input = {
      week,
      userId: owner.clerkUserId,
      version: sheet.version,
      revision: sheet.revision,
      action: 'add',
      work: { taskId: t.id, projectId: p.id },
    };
    const results = await Promise.allSettled([
      service.saveTimesheetWork(owner, input),
      service.saveTimesheetWork(owner, input),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status,
    ).toBe(409);
    const current = await service.timesheet(owner, { week });
    expect(current.workRows?.map((r) => r.key)).toEqual([plannerTimeWorkKey(input.work)]);
  });
});
