import {
  seedTimeSettings,
  seedTimesheet,
  storedTimesheet,
} from './planner-persisted-time.fixture.js';
import { randomUUID } from 'node:crypto';
import {
  plannerWeekDate,
  plannerWeekOn,
  type PlannerTimesheetStatus,
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
    throw Error('Timesheet tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000021';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_time_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_time_owner', role: 'org:member' };
const reviewer = { ...owner, clerkUserId: 'user_time_reviewer' };
let testIndex = 0;
const weekBase = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
describeDb('Planner time entries and persisted weekly locks under forced row security', () => {
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
    await seedTimeSettings(db, admin, {
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

  const setStatus = (status: PlannerTimesheetStatus) =>
    seedTimesheet(db, owner, week, { status, reviewerId: reviewer.clerkUserId });
  it('preserves work dates, attribution and immutable cross-week corrections', async () => {
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
    const before = await storedTimesheet(db, owner, week);
    const changed = await service.reviseEvent(owner, entry.id, {
      version: 0,
      minutes: 45,
      time: { workedOn: plannerWeekDate(week, 7), billable: false },
    });
    expect(changed.time).toMatchObject({
      workedOn: plannerWeekDate(week, 7),
      billable: false,
      projectId: p.id,
    });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(45);
    expect((await storedTimesheet(db, owner, week))!.version).toBeGreaterThan(before!.version);
    expect(await storedTimesheet(db, owner, plannerWeekDate(week, 7))).not.toBeNull();
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await expect(
        tx.spPlannerEventRevision.updateMany({
          where: { tenantId, eventId: entry.id },
          data: { details: {} },
        }),
      ).rejects.toThrow();
    });
  });
  it('enforces persisted submitter and reviewer locks across event edits, removal and restore', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'time',
        text: 'Work',
        minutes: 30,
        time: { workedOn: week },
      },
    );
    await setStatus('submitted');
    await expect(
      service.reviseEvent(owner, e.id, { version: 0, minutes: 35 }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.addEvent(
        owner,
        { projectId: p.id },
        {
          kind: 'time',
          text: 'General',
          minutes: 10,
          time: { workedOn: week },
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await service.reviseEvent(reviewer, e.id, { version: 0, minutes: 40 });
    await expect(
      service.reviseEvent(reviewer, e.id, { version: 0, minutes: 45 }),
    ).rejects.toMatchObject({ status: 409 });
    await setStatus('approved');
    await expect(
      service.reviseEvent(reviewer, e.id, { version: 1, removed: true }),
    ).rejects.toMatchObject({ status: 403 });
    await setStatus('draft');
    await service.reviseEvent(owner, e.id, { version: 1, removed: true });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(0);
    await service.reviseEvent(owner, e.id, { version: 2, removed: false });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(40);
  });
  it('preserves reviewer attribution and allows owner corrections to persisted rejected weeks', async () => {
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
    expect(e.taskId).toBeNull();
    expect(e.projectId).toBe(p.id);
    await setStatus('rejected');
    await service.reviseEvent(owner, e.id, { version: 0, text: 'Corrected planning' });
    expect(
      (await service.events(owner, { projectId: p.id })).find((i) => i.id === e.id)?.text,
    ).toBe('Corrected planning');
  });
  it('never grants private source access through reviewer assignment or an admin role', async () => {
    const p = await project(false),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'time',
        text: 'Private',
        minutes: 55,
        time: { workedOn: week },
      },
    );
    for (const ctx of [
      reviewer,
      admin,
      { ...owner, tenantId: '10000000-0000-4000-8000-000000000022' },
    ]) {
      await expect(service.events(ctx, { taskId: t.id })).rejects.toMatchObject({ status: 404 });
      await expect(
        service.reviseEvent(ctx, e.id, { version: 0, minutes: 20 }),
      ).rejects.toMatchObject({ status: 404 });
    }
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
  it('rechecks project grants before correcting time in an existing submitted week', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'time',
        text: 'Work',
        minutes: 30,
        time: { workedOn: week },
      },
    );
    await setStatus('submitted');
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(
      service.reviseEvent(reviewer, e.id, { version: 0, minutes: 20 }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('requires one authorized attribution for multi-project tasks and rejects forged metadata', async () => {
    const a = await project(),
      b = await project(),
      t = await task(a.id);
    const multi = await service.saveTask(owner, t.id, {
      version: t.version,
      data: { memberships: [...t.memberships, { projectId: b.id, sectionId: null, position: 0 }] },
    });
    for (const time of [{ workedOn: week }, { workedOn: week, projectId: null }]) {
      await expect(
        service.addEvent(
          owner,
          { taskId: multi.id },
          {
            kind: 'time',
            text: 'Work',
            minutes: 30,
            time,
          },
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
    const e = await service.addEvent(
      owner,
      { taskId: multi.id },
      {
        kind: 'time',
        text: 'Work',
        minutes: 30,
        time: { workedOn: week, projectId: b.id },
      },
    );
    expect(e.time?.projectId).toBe(b.id);
    await expect(
      service.reviseEvent(owner, e.id, {
        version: 0,
        time: { projectId: randomUUID() },
      }),
    ).rejects.toThrow();
    expect((await service.resources(owner)).some((r) => (r.kind as string) === 'timesheet')).toBe(
      false,
    );
  });
  it('keeps legacy working dates in UTC and retains metadata through older corrections', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.create({
        data: {
          tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'time',
          text: 'Legacy time',
          minutes: 20,
          createdAt: new Date(week + 'T23:55:00Z'),
        },
      }),
    );
    expect(
      (await service.events(owner, { taskId: t.id })).find((i) => i.id === e.id)?.time,
    ).toMatchObject({ workedOn: week, timeZone: 'UTC', billable: false, projectId: null });
    const revised = await service.reviseEvent(owner, e.id, {
      version: 0,
      minutes: 25,
      time: { billable: true, projectId: p.id },
    });
    await service.reviseEvent(owner, e.id, {
      version: revised.version,
      text: 'Updated legacy note',
    });
    const after = (await service.events(owner, { taskId: t.id })).find((i) => i.id === e.id)!;
    expect(after.minutes).toBe(25);
    expect(after.time).toMatchObject({ workedOn: week, billable: true, projectId: p.id });
  });
  it('audits admin corrections after approval without rewriting an existing approval event', async () => {
    const p = await project(),
      t = await task(p.id);
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'time',
        text: 'Work',
        minutes: 30,
        time: { workedOn: week },
      },
    );
    const sheet = await setStatus('approved');
    const approved = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.create({
        data: {
          tenantId,
          resourceId: sheet.id,
          actorId: reviewer.clerkUserId,
          kind: 'timesheet_status',
          text: 'Historical approval',
          details: { timesheetStatus: { to: 'approved', totalMinutes: 30 } },
        },
      }),
    );
    await service.reviseEvent({ ...owner, role: 'org:admin' }, e.id, { version: 0, minutes: 45 });
    expect((await storedTimesheet(db, owner, week))?.data).toMatchObject({
      status: 'approved',
      correctedAfterApproval: true,
    });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(45);
    const unchanged = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.findFirst({
        where: { tenantId, id: approved.id },
      }),
    );
    expect(unchanged?.details).toEqual(approved.details);
    expect(unchanged?.actorId).toBe(reviewer.clerkUserId);
  });
});
