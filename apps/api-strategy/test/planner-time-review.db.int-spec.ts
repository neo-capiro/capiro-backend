import { randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerWeekDate,
  plannerWeekOn,
  plannerScheduledInstant,
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
    throw Error('Time review tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000033';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_review_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_review_owner', role: 'org:member' };
const reviewer = { ...owner, clerkUserId: 'user_review_reviewer' };
const other = { ...owner, clerkUserId: 'user_review_other' };
const base = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
let index = 0;
describeDb('Time review and submission reminders under the restricted application role', () => {
  let db: PrismaService, service: PlannerService, week: string;
  const role = <T>(run: (tx: Prisma.TransactionClient) => Promise<T>, tenant = tenantId) =>
    db.withTenant(tenant, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return run(tx);
    });
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const ctx of [admin, owner, reviewer, other]) {
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${id}::uuid,${ctx.clerkUserId},${ctx.clerkUserId},${ctx.clerkUserId + '@example.test'}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${tenantId}::uuid,id,'active' FROM users WHERE clerk_user_id=${ctx.clerkUserId} AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenantId}::uuid AND user_id=users.id)`;
      }
    });
    service = new PlannerService(
      {
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
      } as PrismaService,
      { validate: async () => undefined } as unknown as PlannerLinksService,
    );
  });
  const settings = async (
    reviewers = { [owner.clerkUserId]: reviewer.clerkUserId },
    options = PLANNER_DEFAULT_TIME_OPTIONS,
  ) => {
    const old = await service.timeSettings(admin);
    return service.saveTimeSettings(admin, { version: old.version, reviewers, options });
  };
  beforeEach(async () => {
    week = plannerWeekDate(base, 28 * index++);
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status=CASE WHEN user_id IN (SELECT id FROM users WHERE clerk_user_id IN (${admin.clerkUserId},${owner.clerkUserId},${reviewer.clerkUserId},${other.clerkUserId})) THEN 'active' ELSE 'inactive' END WHERE tenant_id=${tenantId}::uuid`,
    );
    await settings();
  });
  afterAll(async () => db?.$disconnect());
  const work = async (ctx = owner, minutes = 60, billable = false) => {
    const p = await service.saveProject(ctx, null, {
      data: {
        name: 'Review QA ' + randomUUID(),
        privacy: 'private',
        members: [{ userId: reviewer.clerkUserId, role: 'editor' }],
      },
    });
    const t = await service.saveTask(ctx, null, {
      data: {
        name: 'Review work',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const e = await service.addEvent(
      ctx,
      { taskId: t.id },
      { kind: 'time', minutes, text: 'Review time', time: { workedOn: week, billable } },
    );
    return { p, t, e };
  };
  const transition = async (ctx: AuthTenantContext, action: string, userId = owner.clerkUserId) => {
    const s = await service.timesheet(ctx, { week, userId });
    return service.transitionTimesheet(ctx, {
      week,
      userId,
      version: s.version,
      revision: s.revision,
      action,
      notes: 'Review QA',
    });
  };
  const enable = () =>
    settings(undefined, {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      submissionReminder: { weekday: 1, time: '09:00', week: 'current' },
    });
  const due = () => new Date(`${week}T09:00:00Z`);
  it('merges private saved review views without changing auto-add and rejects stale or foreign edits', async () => {
    let prefs = await service.timePreferences(reviewer);
    await service.saveTimePreferences(reviewer, { version: prefs.version, autoAddDueTasks: true });
    prefs = await service.timePreferences(reviewer);
    const view = {
      people: [owner.clerkUserId],
      statuses: ['submitted'],
      sort: 'total',
      direction: 'desc',
    };
    const saved = await service.saveTimePreferences(reviewer, {
      version: prefs.version,
      reviewView: view,
    });
    expect(await service.timePreferences(reviewer)).toEqual({
      version: saved.version,
      autoAddDueTasks: true,
      reviewView: view,
    });
    await expect(
      service.saveTimePreferences(reviewer, { version: prefs.version, reviewView: view }),
    ).rejects.toMatchObject({ status: 409 });
    await service.saveTimePreferences(reviewer, { version: saved.version, autoAddDueTasks: false });
    expect((await service.timePreferences(reviewer)).reviewView).toEqual(view);
    expect((await service.timePreferences(owner)).reviewView).toBeUndefined();
    await expect(
      service.saveTimePreferences(owner, {
        version: 0,
        reviewView: view,
        userId: reviewer.clerkUserId,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      (await service.resources(reviewer)).some((r) => r.name === 'Personal timesheet settings'),
    ).toBe(false);
  });
  it('filters only assigned submitters and sorts visible totals before paging; access changes invalidate the view', async () => {
    await settings({
      [owner.clerkUserId]: reviewer.clerkUserId,
      [other.clerkUserId]: reviewer.clerkUserId,
    });
    const a = await work(owner, 60, true);
    await work(other, 90, false);
    await transition(owner, 'submit');
    const total = await service.timeReview(reviewer, {
      week,
      paged: 'true',
      sort: 'total',
      direction: 'desc',
    });
    expect(total.items.map((s) => s.userId)).toEqual([other.clerkUserId, owner.clerkUserId]);
    expect(total.totalMinutes).toBe(150);
    expect(total.billableMinutes).toBe(60);
    const billable = await service.timeReview(reviewer, {
      week,
      paged: 'true',
      sort: 'billable',
      direction: 'desc',
      statuses: 'submitted',
    });
    expect(billable.items.map((s) => s.userId)).toEqual([owner.clerkUserId]);
    expect(billable.items[0]?.items).toEqual([]);
    expect(billable.items[0]?.history).toEqual([]);
    expect(
      (await service.timeReview(reviewer, { week, paged: 'true', people: admin.clerkUserId }))
        .matched,
    ).toBe(0);
    await service.saveProject(owner, a.p.id, { version: a.p.version, data: { members: [] } });
    await expect(
      service.timeReview(reviewer, { week, paged: 'true', revision: total.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const visible = await service.timeReview(reviewer, {
      week,
      paged: 'true',
      people: owner.clerkUserId,
    });
    expect(visible.totalMinutes).toBe(0);
    expect(visible.items[0]?.unavailableEntries).toBe(true);
    // Status snapshots are internal metadata, never leaked through history or Inbox.
    const history = await service.timesheet(reviewer, { week, userId: owner.clerkUserId });
    expect(history.history[0]).not.toHaveProperty('timesheetStatus');
    expect(JSON.stringify(history.history)).not.toContain('totalMinutes');
    await settings({});
    expect((await service.timeReview(reviewer, { week, paged: 'true' })).matched).toBe(0);
    await expect(
      service.timesheet(reviewer, { week, userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.timesheet(admin, { week, userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('pages all 121 assigned people with globally stable ordering and rejects a changed assignment', async () => {
    const users = Array.from(
      { length: 121 },
      (_, i) => 'user_review_page_' + String(i).padStart(3, '0'),
    );
    await db.withTenant(tenantId, async (tx) => {
      for (const subject of users) {
        const id = randomUUID();
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${id}::uuid,${subject},${subject},${subject + '@example.test'}) ON CONFLICT DO NOTHING`;
        await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${tenantId}::uuid,id,'active' FROM users WHERE clerk_user_id=${subject} AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${tenantId}::uuid AND user_id=users.id)`;
        await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid AND user_id=(SELECT id FROM users WHERE clerk_user_id=${subject})`;
      }
    });
    await settings(Object.fromEntries(users.map((u) => [u, reviewer.clerkUserId])));
    const first = await service.timeReview(reviewer, { week, paged: 'true' });
    expect(first.matched).toBe(121);
    expect(first.items).toHaveLength(100);
    const last = await service.timeReview(reviewer, {
      week,
      paged: 'true',
      cursor: first.nextCursor!,
      revision: first.revision,
    });
    expect(last.items).toHaveLength(21);
    expect(last.nextCursor).toBeNull();
    expect([...first.items, ...last.items].map((s) => s.userId)).toEqual(users);
    await settings(Object.fromEntries(users.slice(1).map((u) => [u, reviewer.clerkUserId])));
    await expect(
      service.timeReview(reviewer, {
        week,
        paged: 'true',
        cursor: first.nextCursor!,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
  }, 60000);
  it('pages status history with database microsecond ordering and rejects foreign and stale cursors', async () => {
    await work();
    const s = await transition(owner, 'submit');
    const ids = Array.from({ length: 120 }, () => randomUUID());
    await role(async (tx) => {
      for (let i = 0; i < ids.length; i++)
        await tx.$executeRaw`INSERT INTO sp_planner_events(id,tenant_id,resource_id,actor_id,kind,text,details,created_at) VALUES(${ids[i]}::uuid,${tenantId}::uuid,${s.id}::uuid,${owner.clerkUserId},'timesheet_status','Synthetic status page','{}'::jsonb, TIMESTAMPTZ '2000-01-01 00:00:00+00' + ${i} * INTERVAL '1 microsecond')`;
    });
    const first = await service.timesheet(owner, { week });
    expect(first.history).toHaveLength(100);
    const last = await service.timesheet(owner, {
      week,
      historyCursor: first.nextHistoryCursor!,
      revision: first.revision,
    });
    expect(last.history).toHaveLength(21);
    expect(last.nextHistoryCursor).toBeNull();
    expect(new Set([...first.history, ...last.history].map((e) => e.id)).size).toBe(121);
    expect(last.history.map((e) => e.id)).toEqual(ids.slice(0, 21).reverse());
    await expect(
      service.timesheet(owner, { week, historyCursor: randomUUID(), revision: first.revision }),
    ).rejects.toMatchObject({ status: 400 });
    await transition(reviewer, 'reject');
    await expect(
      service.timesheet(owner, {
        week,
        historyCursor: first.nextHistoryCursor!,
        revision: first.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows only the assigned reviewer to recall a rejected decision and relocks the owner', async () => {
    const w = await work();
    await transition(owner, 'submit');
    const rejected = await transition(reviewer, 'reject');
    expect(rejected.actions).toContain('recall_approval');
    await expect(transition(owner, 'recall_approval')).rejects.toMatchObject({ status: 403 });
    expect((await transition(reviewer, 'recall_approval')).status).toBe('submitted');
    await expect(
      service.reviseEvent(owner, w.e.id, { version: 0, minutes: 90 }),
    ).rejects.toMatchObject({ status: 403 });
    await transition(reviewer, 'reject');
    expect((await transition(owner, 'submit')).status).toBe('submitted');
  });
  it('keeps reminders disabled by default and delivers an exact owner-only Inbox/bell link once per week', async () => {
    expect(await service.runScheduledTimeWork(tenantId, due())).toEqual({
      executed: 0,
      failed: 0,
      nextCursor: null,
    });
    await enable();
    expect(
      (await service.runScheduledTimeWork(tenantId, new Date(`${week}T08:59:59Z`))).executed,
    ).toBe(0);
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(1);
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    const inbox = (await service.inbox(owner)).filter(
      (i) => i.event.kind === 'reminder' && i.event.timesheet?.weekOn === week,
    );
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.event.timesheet).toEqual({ weekOn: week, userId: owner.clerkUserId });
    const bell = await service.notifications(owner);
    expect(bell.items.some((i) => i.id === inbox[0]?.id)).toBe(true);
    expect((await service.inbox(reviewer)).some((i) => i.event.id === inbox[0]?.event.id)).toBe(
      false,
    );
    expect((await service.timesheet(owner, { week })).totalMinutes).toBe(0);
    // Changing the schedule cannot resend this sheet's reminder.
    await settings(undefined, {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      submissionReminder: { weekday: 1, time: '08:00', week: 'current' },
    });
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    expect(
      (
        await service.runScheduledTimeWork(
          tenantId,
          new Date(`${plannerWeekDate(week, 7)}T09:00:00Z`),
        )
      ).executed,
    ).toBe(1);
  });
  it('commits one receipt and notification across concurrent workers and retries a rolled-back delivery', async () => {
    await enable();
    const results = await Promise.all([
      service.runScheduledTimeWork(tenantId, due()),
      service.runScheduledTimeWork(tenantId, due()),
    ]);
    expect(results.reduce((n, r) => n + r.executed, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.failed, 0)).toBe(0);
    week = plannerWeekDate(week, 7);
    const original = (service as any).event.bind(service);
    const spy = jest.spyOn(service as any, 'event');
    spy.mockImplementationOnce(async (...args: any[]) => {
      await original(...args);
      throw Error('Synthetic delivery failure');
    });
    expect((await service.runScheduledTimeWork(tenantId, due())).failed).toBe(1);
    expect((await service.inbox(owner)).some((i) => i.event.timesheet?.weekOn === week)).toBe(
      false,
    );
    spy.mockRestore();
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(1);
    expect(
      (await service.inbox(owner)).filter((i) => i.event.timesheet?.weekOn === week),
    ).toHaveLength(1);
  });
  it('skips submitted, approved and inactive submitters or reviewers; simple submission uses active members', async () => {
    await work();
    await transition(owner, 'submit');
    await enable();
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    await transition(reviewer, 'approve');
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    week = plannerWeekDate(week, 7);
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id=(SELECT id FROM users WHERE clerk_user_id=${reviewer.clerkUserId})`,
    );
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    await settings(
      {},
      {
        ...PLANNER_DEFAULT_TIME_OPTIONS,
        approvalProcess: 'simple',
        submissionReminder: { weekday: 1, time: '09:00', week: 'current' },
      },
    );
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(3);
    expect((await service.inbox(reviewer)).some((i) => i.event.timesheet?.weekOn === week)).toBe(
      false,
    );
  });
  it('targets the previous calendar week at the configured local deadline', async () => {
    await settings(undefined, {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      timeZone: 'America/New_York',
      submissionReminder: { weekday: 1, time: '09:00', week: 'previous' },
    });
    const deadline = plannerScheduledInstant(week, '09:00', 'America/New_York');
    expect(
      (await service.runScheduledTimeWork(tenantId, new Date(deadline.getTime() - 1))).executed,
    ).toBe(0);
    expect((await service.runScheduledTimeWork(tenantId, deadline)).executed).toBe(1);
    const target = plannerWeekDate(week, -7);
    expect(
      (await service.inbox(owner)).filter(
        (i) => i.event.timesheet?.weekOn === target && i.event.kind === 'reminder',
      ),
    ).toHaveLength(1);
    expect(
      await role((tx) =>
        tx.spPlannerTimeReminderClaim.count({
          where: { tenantId, ownerId: owner.clerkUserId, weekOn: new Date(target + 'T00:00:00Z') },
        }),
      ),
    ).toBe(1);
  });
  it('delivers all 121 eligible submitters in bounded pages without duplicate receipts', async () => {
    const users = Array.from(
      { length: 121 },
      (_, i) => 'user_review_page_' + String(i).padStart(3, '0'),
    );
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid AND user_id IN (SELECT id FROM users WHERE clerk_user_id LIKE 'user_review_page_%')`,
    );
    await settings(Object.fromEntries(users.map((u) => [u, reviewer.clerkUserId])), {
      ...PLANNER_DEFAULT_TIME_OPTIONS,
      submissionReminder: { weekday: 1, time: '09:00', week: 'current' },
    });
    const first = await service.runScheduledTimeWork(tenantId, due());
    expect(first).toEqual({ executed: 50, failed: 0, nextCursor: users[49] });
    const second = await service.runScheduledTimeWork(tenantId, due(), first.nextCursor!);
    expect(second).toEqual({ executed: 50, failed: 0, nextCursor: users[99] });
    expect(await service.runScheduledTimeWork(tenantId, due(), second.nextCursor!)).toEqual({
      executed: 21,
      failed: 0,
      nextCursor: null,
    });
    expect((await service.runScheduledTimeWork(tenantId, due())).executed).toBe(0);
    expect(
      await role((tx) =>
        tx.spPlannerTimeReminderClaim.count({
          where: { tenantId, weekOn: new Date(week + 'T00:00:00Z') },
        }),
      ),
    ).toBe(121);
  }, 60000);
  it('enforces receipt row security, Monday dates and append-only rights', async () => {
    await enable();
    await service.runScheduledTimeWork(tenantId, due());
    const claims = await role((tx) =>
      tx.spPlannerTimeReminderClaim.findMany({
        where: { tenantId, weekOn: new Date(week + 'T00:00:00Z') },
      }),
    );
    expect(claims).toHaveLength(1);
    await expect(
      role((tx) =>
        tx.spPlannerTimeReminderClaim.update({
          where: { id: claims[0]!.id },
          data: { ownerId: other.clerkUserId },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      role((tx) => tx.spPlannerTimeReminderClaim.delete({ where: { id: claims[0]!.id } })),
    ).rejects.toThrow();
    const foreign = '10000000-0000-4000-8000-000000003333';
    expect(
      await role(
        (tx) =>
          tx.$queryRaw`SELECT id FROM sp_planner_time_reminder_claims WHERE tenant_id=${tenantId}::uuid`,
        foreign,
      ),
    ).toEqual([]);
    await expect(
      role((tx) =>
        tx.spPlannerTimeReminderClaim.create({
          data: { ...claims[0]!, id: randomUUID(), tenantId: foreign },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      role((tx) =>
        tx.spPlannerTimeReminderClaim.create({
          data: {
            ...claims[0]!,
            id: randomUUID(),
            ownerId: other.clerkUserId,
            weekOn: new Date(plannerWeekDate(week, 1) + 'T00:00:00Z'),
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
