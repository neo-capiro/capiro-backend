import { randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeToday,
  plannerWeekDate,
  plannerWeekOn,
  type PlannerTimeOptions,
} from '@capiro/strategy-verifier';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const u = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/planner_qa')
    throw Error('Time settings tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000031';
const admin: AuthTenantContext = {
  tenantId,
  clerkUserId: 'user_time_settings_admin',
  role: 'org:admin',
};
const owner: AuthTenantContext = {
  ...admin,
  clerkUserId: 'user_time_settings_owner',
  role: 'org:member',
};
const ownerAdmin = { ...owner, role: 'org:admin' };
const reviewer = { ...owner, clerkUserId: 'user_time_settings_reviewer' };
const weekBase = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
let index = 0;

describeDb('Organization time policy with the restricted application database role', () => {
  let db: PrismaService, service: PlannerService, week: string;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const [id, subject] of [
        ['94000000-0000-4000-8000-000000000001', admin.clerkUserId],
        ['94000000-0000-4000-8000-000000000002', owner.clerkUserId],
        ['94000000-0000-4000-8000-000000000003', reviewer.clerkUserId],
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
  const change = async (
    options: Partial<PlannerTimeOptions>,
    reviewers?: Record<string, string>,
  ) => {
    const current = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: current.version,
      reviewers: reviewers ?? current.reviewers,
      options,
    });
    return service.timeSettings(admin);
  };
  beforeEach(async () => {
    week = plannerWeekDate(weekBase, 14 * index++);
    await change(PLANNER_DEFAULT_TIME_OPTIONS, { [owner.clerkUserId]: reviewer.clerkUserId });
  });
  afterAll(async () => db?.$disconnect());
  const project = (share = true) =>
    service.saveProject(owner, null, {
      data: {
        name: 'Synthetic time settings ' + randomUUID(),
        privacy: 'private',
        members: share ? [{ userId: reviewer.clerkUserId, role: 'editor' }] : [],
      },
    });
  const task = (projectId: string) =>
    service.saveTask(owner, null, {
      data: {
        name: 'Synthetic policy task',
        memberships: [{ projectId, sectionId: null, position: 0 }],
      },
    });
  const log = (taskId: string, workedOn = week, details = {}) =>
    service.addEvent(
      owner,
      { taskId },
      { kind: 'time', text: 'Synthetic work', minutes: 30, time: { workedOn, ...details } },
    );
  const status = async (ctx: AuthTenantContext, action: string) => {
    const sheet = await service.timesheet(ctx, { week, userId: owner.clerkUserId });
    return service.transitionTimesheet(ctx, {
      week,
      userId: owner.clerkUserId,
      version: sheet.version,
      revision: sheet.revision,
      action,
      notes: 'Synthetic policy review',
    });
  };

  it('requires organization admin, captures versions and keeps options for older reviewer-only clients', async () => {
    const opening = await service.timeSettings(owner);
    expect(opening.canManage).toBe(false);
    await expect(
      service.saveTimeSettings(owner, {
        version: opening.version,
        reviewers: {},
        options: { billableDefault: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const saved = await change({
      billableDefault: true,
      categories: ['Research'],
      timeZone: 'America/New_York',
    });
    await expect(
      service.saveTimeSettings(admin, { version: opening.version, reviewers: {} }),
    ).rejects.toMatchObject({ status: 409 });
    await service.saveTimeSettings(admin, { version: saved.version, reviewers: saved.reviewers });
    expect((await service.timeSettings(owner)).options).toEqual(saved.options);
    const boot = await service.bootstrap(owner);
    expect(boot.timeOptions).toEqual(saved.options);
    expect(boot.timeAdmin).toBe(false);
    expect((await service.bootstrap(ownerAdmin)).timeAdmin).toBe(true);
  });
  it('applies organization defaults and explicit overrides without rewriting historical categories or billable time', async () => {
    const p = await project(),
      t = await task(p.id);
    await change({ billableDefault: true, categories: ['Research'], timeZone: 'America/New_York' });
    const implicit = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Default date', minutes: 10 },
    );
    expect(implicit.time).toMatchObject({
      billable: true,
      timeZone: 'America/New_York',
      workedOn: plannerTimeToday('America/New_York'),
    });
    const e = await log(t.id, week, { category: 'Research' });
    expect(e.time?.billable).toBe(true);
    expect((await log(t.id, week, { billable: false, category: 'Research' })).time?.billable).toBe(
      false,
    );
    await change({ billableEnabled: false, categories: ['Delivery'] });
    await service.reviseEvent(owner, e.id, { version: 0, text: 'Retained historical metadata' });
    expect(
      (await service.timesheet(owner, { week })).items.find((i) => i.id === e.id)?.time,
    ).toMatchObject({ category: 'Research', billable: true });
    await expect(log(t.id, week, { billable: true, category: 'Delivery' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(log(t.id, week, { category: 'Research' })).rejects.toMatchObject({ status: 400 });
    const corrected = await service.reviseEvent(owner, e.id, {
      version: 1,
      time: { category: 'Delivery', billable: false },
    });
    expect(corrected.time).toMatchObject({ category: 'Delivery', billable: false });
    await expect(
      service.reviseEvent(owner, e.id, { version: 2, time: { billable: true } }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('blocks new general project work while allowing corrections to historical general entries', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { projectId: p.id },
      { kind: 'time', text: 'General work', minutes: 20, time: { workedOn: week } },
    );
    await change({ generalWorkEnabled: false });
    await expect(
      service.addEvent(
        owner,
        { projectId: p.id },
        { kind: 'time', text: 'New general work', minutes: 20, time: { workedOn: week } },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.reviseEvent(owner, e.id, { version: 0, minutes: 15 });
    await log(t.id);
    expect((await service.timesheet(owner, { week })).totalMinutes).toBe(45);
  });
  it('disables writes and changed estimates while preserving history and ordinary task edits', async () => {
    const p = await project(),
      t = await task(p.id),
      e = await log(t.id);
    const estimated = await service.saveTask(owner, t.id, {
      version: t.version,
      data: { estimateMinutes: 90 },
    });
    await change({ timeTrackingEnabled: false });
    await expect(log(t.id)).rejects.toMatchObject({ status: 403 });
    for (const patch of [
      { minutes: 40 },
      { removed: true },
      { time: { workedOn: plannerWeekDate(week, 7) } },
    ])
      await expect(
        service.reviseEvent(ownerAdmin, e.id, { version: 0, ...patch }),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.saveTask(owner, t.id, { version: estimated.version, data: { estimateMinutes: 120 } }),
    ).rejects.toMatchObject({ status: 403 });
    await service.saveTask(owner, t.id, {
      version: estimated.version,
      data: { name: 'Renamed with time disabled' },
    });
    const sheet = await service.timesheet(owner, { week });
    expect(sheet.totalMinutes).toBe(30);
    expect(sheet.canLogTime).toBe(false);
    expect(sheet.items[0]?.canEdit).toBe(false);
    expect(sheet.timeNotice).toContain('disabled');
  });
  it('checks both original and destination dates on moving, removing and restoring locked time', async () => {
    const currentWeek = plannerWeekOn(plannerTimeToday('UTC'));
    const p = await project(),
      t = await task(p.id);
    const past = await log(t.id, plannerWeekDate(currentWeek, -14));
    const removed = await log(t.id, plannerWeekDate(currentWeek, -7));
    await service.reviseEvent(owner, removed.id, { version: 0, removed: true });
    await change({ pastLockWeeks: 0 });
    for (const patch of [{ removed: true }, { minutes: 40 }, { time: { workedOn: currentWeek } }])
      await expect(
        service.reviseEvent(owner, past.id, { version: 0, ...patch }),
      ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.reviseEvent(owner, removed.id, { version: 1, removed: false }),
    ).rejects.toMatchObject({ status: 403 });
    const now = await log(t.id, currentWeek);
    await expect(
      service.reviseEvent(owner, now.id, {
        version: 0,
        time: { workedOn: plannerWeekDate(currentWeek, -7) },
      }),
    ).rejects.toMatchObject({ status: 403 });
    await service.reviseEvent(ownerAdmin, past.id, { version: 0, minutes: 25 });
    await service.reviseEvent(ownerAdmin, removed.id, { version: 1, removed: false });
    await expect(
      service.reviseEvent(admin, past.id, { version: 1, minutes: 10 }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('allows the current week through Sunday and rejects future logging for admins too', async () => {
    const currentWeek = plannerWeekOn(plannerTimeToday('America/New_York'));
    const p = await project(),
      t = await task(p.id);
    await change({ futureWeeks: 0, timeZone: 'America/New_York' });
    const e = await log(t.id, plannerWeekDate(currentWeek, 6));
    await expect(log(t.id, plannerWeekDate(currentWeek, 7))).rejects.toMatchObject({ status: 403 });
    await expect(
      service.reviseEvent(ownerAdmin, e.id, {
        version: 0,
        time: { workedOn: plannerWeekDate(currentWeek, 7) },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await service.timesheet(ownerAdmin, { week: plannerWeekDate(currentWeek, 7) })).canLogTime,
    ).toBe(false);
  });
  it('submits without a reviewer in simple mode and keeps immutable submission and recall history', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id);
    await change({ approvalProcess: 'simple' }, {});
    const submitted = await status(owner, 'submit');
    expect(submitted.status).toBe('submitted');
    expect(submitted.reviewerId).toBeNull();
    expect(submitted.approvalProcess).toBe('simple');
    await expect(log(t.id)).rejects.toMatchObject({ status: 403 });
    const recalled = await status(owner, 'recall_submission');
    expect(recalled.status).toBe('draft');
    expect(recalled.history).toHaveLength(2);
    expect(recalled.history.every((e) => e.kind === 'timesheet_status')).toBe(true);
  });
  it('invalidates captured revisions when time policy changes and permits recall of older full approvals', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id);
    const opening = await service.timesheet(owner, { week });
    await change({ categories: ['Research'] });
    await expect(
      service.timesheet(owner, { week, revision: opening.revision }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.transitionTimesheet(owner, {
        week,
        userId: owner.clerkUserId,
        version: opening.version,
        revision: opening.revision,
        action: 'submit',
        notes: '',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await status(owner, 'submit');
    await status(reviewer, 'approve');
    await change({ approvalProcess: 'simple' });
    expect((await status(reviewer, 'recall_approval')).status).toBe('submitted');
    expect((await status(owner, 'recall_submission')).status).toBe('draft');
  });
});
