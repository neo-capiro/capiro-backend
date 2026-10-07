import { randomUUID } from 'node:crypto';
import { plannerWeekDate, plannerWeekOn } from '@capiro/strategy-verifier';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const u = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname != '/planner_qa')
    throw Error('Timesheet tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000021';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_time_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_time_owner', role: 'org:member' };
const reviewer = { ...owner, clerkUserId: 'user_time_reviewer' };
let testIndex = 0;
const weekBase = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
describeDb('Planner time entries and weekly review under forced row security', () => {
  let db: PrismaService, service: PlannerService, week: string;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const [id, subject, name] of [
        ['93000000-0000-4000-8000-000000000001', admin.clerkUserId, 'Time Admin'],
        ['93000000-0000-4000-8000-000000000002', owner.clerkUserId, 'Time Owner'],
        ['93000000-0000-4000-8000-000000000003', reviewer.clerkUserId, 'Time Reviewer'],
      ]) {
        await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${id}::uuid,${subject},${name},${subject + '@example.test'}) ON CONFLICT DO NOTHING`;
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
  beforeEach(async () => {
    // Unique calendar weeks preserve the immutable records from each case and rerun.
    week = plannerWeekDate(weekBase, 14 * testIndex++);
    const settings = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: settings.version,
      reviewers: { [owner.clerkUserId]: reviewer.clerkUserId },
    });
  });
  afterAll(async () => db?.$disconnect());
  const project = (share = true) =>
    service.saveProject(owner, null, {
      data: {
        name: 'Synthetic time project ' + randomUUID(),
        privacy: 'private',
        members: share ? [{ userId: reviewer.clerkUserId, role: 'editor' }] : [],
      },
    });
  const task = (projectId: string) =>
    service.saveTask(owner, null, {
      data: {
        name: 'Synthetic time task',
        memberships: [{ projectId, sectionId: null, position: 0 }],
      },
    });
  const status = async (ctx: AuthTenantContext, action: string, user = owner.clerkUserId) => {
    const view = await service.timesheet(ctx, { week, userId: user });
    return service.transitionTimesheet(ctx, {
      week,
      userId: user,
      version: view.version,
      revision: view.revision,
      action,
      notes: 'Synthetic review',
    });
  };
  it('preserves work dates, billable/project attribution and immutable cross-week corrections', async () => {
    const p = await project(),
      t = await task(p.id);
    const entry = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'time',
        text: 'Research',
        minutes: 60,
        time: { workedOn: week, billable: true, timeZone: 'America/New_York' },
      },
    );
    expect(entry.time).toMatchObject({ workedOn: week, billable: true, projectId: p.id });
    let sheet = await service.timesheet(owner, { week });
    expect(sheet.totalMinutes).toBe(60);
    expect(sheet.billableMinutes).toBe(60);
    const changed = await service.reviseEvent(owner, entry.id, {
      version: 0,
      minutes: 45,
      time: { workedOn: plannerWeekDate(week, 7), billable: false },
    });
    expect(changed.time?.projectId).toBe(p.id);
    expect((await service.timesheet(owner, { week })).totalMinutes).toBe(0);
    expect((await service.timesheet(owner, { week: plannerWeekDate(week, 7) })).totalMinutes).toBe(
      45,
    );
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await expect(
        tx.$executeRaw`UPDATE sp_planner_event_revisions SET details='{}' WHERE event_id=${entry.id}::uuid`,
      ).rejects.toThrow();
    });
  });
  it('enforces submitter/reviewer locks across all event routes, version guards and recalls', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week } },
    );
    const submitted = await status(owner, 'submit');
    expect(submitted.status).toBe('submitted');
    await expect(
      service.reviseEvent(owner, e.id, { version: 0, minutes: 35 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.addEvent(
        owner,
        { projectId: p.id },
        { kind: 'time', text: 'General', minutes: 10, time: { workedOn: week } },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.reviseEvent(reviewer, e.id, { version: 0, minutes: 40 });
    await expect(
      service.transitionTimesheet(reviewer, {
        week,
        userId: owner.clerkUserId,
        version: submitted.version,
        revision: submitted.revision,
        action: 'approve',
        notes: '',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await status(reviewer, 'approve')).status).toBe('approved');
    await expect(
      service.reviseEvent(reviewer, e.id, { version: 1, removed: true }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(status(owner, 'recall_submission')).rejects.toMatchObject({ status: 403 });
    expect((await status(reviewer, 'recall_approval')).status).toBe('submitted');
    expect((await status(owner, 'recall_submission')).status).toBe('draft');
    await service.reviseEvent(owner, e.id, { version: 1, removed: true });
    expect((await service.timesheet(owner, { week })).matched).toBe(0);
    await service.reviseEvent(owner, e.id, { version: 2, removed: false });
    expect((await service.timesheet(owner, { week })).totalMinutes).toBe(40);
  });
  it('allows reviewer general-project logging on behalf of the submitter and rejection/resubmission', async () => {
    const p = await project();
    const e = await service.addEvent(
      reviewer,
      { projectId: p.id },
      {
        kind: 'time',
        text: 'General planning',
        minutes: 90,
        loggerId: owner.clerkUserId,
        time: { workedOn: week, billable: true, category: 'Planning' },
      },
    );
    expect(e.actorId).toBe(owner.clerkUserId);
    expect(e.recordedBy).toBe(reviewer.clerkUserId);
    const view = await service.timesheet(owner, { week });
    expect(view.items[0]!.taskId).toBeNull();
    expect(view.items[0]!.projectName).toBe(p.name);
    await status(owner, 'submit');
    expect((await status(reviewer, 'reject')).status).toBe('rejected');
    await service.reviseEvent(owner, e.id, { version: 0, text: 'Corrected planning' });
    expect((await status(reviewer, 'submit')).status).toBe('submitted');
    expect(
      (await service.notifications(owner)).items.some((i) =>
        i.deepLink.includes('scope=timesheets'),
      ),
    ).toBe(true);
    const inbox = (await service.inbox(owner)).find((i) => i.event.kind === 'timesheet_status')!;
    await service.updateInbox(owner, inbox.id, { read: true, archived: true });
  });
  it('never grants private source access through reviewer assignment or an admin role', async () => {
    const p = await project(false),
      t = await task(p.id);
    await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Private', minutes: 55, time: { workedOn: week } },
    );
    const view = await service.timesheet(reviewer, { week, userId: owner.clerkUserId });
    expect(view.items).toEqual([]);
    expect(view.totalMinutes).toBe(0);
    expect(view.unavailableEntries).toBe(true);
    expect(view.actions).not.toContain('submit');
    await expect(
      service.timesheet(admin, { week, userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.timesheet({ ...owner, tenantId: '10000000-0000-4000-8000-000000000022' }, { week }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.addEvent(
        admin,
        { projectId: p.id },
        {
          kind: 'time',
          text: 'Private',
          minutes: 10,
          loggerId: owner.clerkUserId,
          time: { workedOn: week },
        },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks grants on later pages and approval, and revokes former reviewer notification access', async () => {
    const p = await project(),
      t = await task(p.id);
    await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week } },
    );
    await status(owner, 'submit');
    const before = await service.timesheet(reviewer, { week, userId: owner.clerkUserId });
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(
      service.timesheet(reviewer, { week, userId: owner.clerkUserId, revision: before.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const settings = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, { version: settings.version, reviewers: {} });
    await expect(
      service.timesheet(reviewer, { week, userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (await service.notifications(reviewer)).items.filter((i) => i.event.resourceId === before.id),
    ).toEqual([]);
    await expect(
      service.saveTimeSettings(owner, { version: 0, reviewers: {} }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('requires one authorized attribution for multi-project tasks and rejects forged metadata', async () => {
    const a = await project(),
      b = await project(),
      t = await task(a.id);
    const multi = await service.saveTask(owner, t.id, {
      version: t.version,
      data: { memberships: [...t.memberships, { projectId: b.id, sectionId: null, position: 0 }] },
    });
    await expect(
      service.addEvent(
        owner,
        { taskId: multi.id },
        { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week } },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.addEvent(
        owner,
        { taskId: multi.id },
        { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week, projectId: null } },
      ),
    ).rejects.toMatchObject({ status: 400 });
    const e = await service.addEvent(
      owner,
      { taskId: multi.id },
      { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week, projectId: b.id } },
    );
    expect(e.time?.projectId).toBe(b.id);
    await expect(
      service.reviseEvent(owner, e.id, { version: 0, time: { projectId: randomUUID() } }),
    ).rejects.toThrow();
    expect((await service.resources(owner)).some((r) => (r.kind as string) === 'timesheet')).toBe(
      false,
    );
  });
  it('aggregates 121 entries before pagination and rejects mixed pages after a correction', async () => {
    const p = await project(),
      t = await task(p.id);
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.spPlannerEvent.createMany({
        data: Array.from({ length: 121 }, (_, i) => ({
          tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'time',
          text: 'Synthetic paged time',
          minutes: 1,
          details: {
            time: {
              workedOn: week,
              timeZone: 'UTC',
              billable: i % 2 === 0,
              projectId: p.id,
              category: '',
            },
          },
        })),
      });
    });
    const first = await service.timesheet(owner, { week });
    expect(first.totalMinutes).toBe(121);
    expect(first.billableMinutes).toBe(61);
    expect(first.items).toHaveLength(100);
    const second = await service.timesheet(owner, {
      week,
      cursor: first.nextCursor!,
      revision: first.revision,
    });
    expect(second.items).toHaveLength(21);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((e) => e.id)).size).toBe(121);
    await service.reviseEvent(owner, first.items[0]!.id, { version: 0, minutes: 2 });
    await expect(
      service.timesheet(owner, { week, cursor: first.nextCursor!, revision: first.revision }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('keeps legacy working dates in UTC and retains metadata through older corrections', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return tx.spPlannerEvent.create({
        data: {
          tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'time',
          text: 'Legacy time',
          minutes: 20,
          createdAt: new Date(week + 'T23:55:00Z'),
        },
      });
    });
    const before = await service.timesheet(owner, { week });
    expect(before.items[0]!.time).toMatchObject({
      workedOn: week,
      timeZone: 'UTC',
      billable: false,
      projectId: null,
    });
    const revised = await service.reviseEvent(owner, e.id, {
      version: 0,
      minutes: 25,
      time: { billable: true, projectId: p.id },
    });
    await service.reviseEvent(owner, e.id, {
      version: revised.version,
      text: 'Updated legacy note',
    });
    const after = await service.timesheet(owner, { week });
    expect(after.totalMinutes).toBe(25);
    expect(after.billableMinutes).toBe(25);
    expect(after.items[0]!.time.projectId).toBe(p.id);
  });
  it('audits admin corrections after approval without rewriting the approved snapshot', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Work', minutes: 30, time: { workedOn: week } },
    );
    await status(owner, 'submit');
    await status(reviewer, 'approve');
    await service.reviseEvent({ ...owner, role: 'org:admin' }, e.id, { version: 0, minutes: 45 });
    const after = await service.timesheet(owner, { week });
    expect(after.status).toBe('approved');
    expect(after.correctedAfterApproval).toBe(true);
    expect(after.totalMinutes).toBe(45);
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const approved = await tx.spPlannerEvent.findFirst({
        where: {
          tenantId,
          resourceId: after.id!,
          details: { path: ['timesheetStatus', 'to'], equals: 'approved' },
        },
      });
      expect((approved!.details as any).timesheetStatus.totalMinutes).toBe(30);
      expect(approved!.actorId).toBe(reviewer.clerkUserId);
    });
  });
});
