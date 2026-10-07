import { randomUUID } from 'node:crypto';
import {
  PLANNER_DEFAULT_TIME_OPTIONS,
  plannerTimeToday,
  plannerWeekOn,
  plannerWeekDate,
} from '@capiro/strategy-verifier';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
const url = process.env.PLANNER_TEST_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.pathname !== '/planner_qa')
    throw Error('Timer tests require dedicated localhost planner_qa');
}
const tenantId = '10000000-0000-4000-8000-000000000037';
const secondTenantId = '10000000-0000-4000-8000-000000000038';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_timer_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_timer_owner', role: 'org:member' };
const other = { ...owner, clerkUserId: 'user_timer_other' };
const links = { validate: async () => undefined } as unknown as PlannerLinksService;
const start = new Date('2027-04-07T12:00:00Z');
(url ? describe : describe.skip)('Native timers under restricted PostgreSQL privileges', () => {
  let db: PrismaService, service: PlannerService;
  const scoped = <T>(
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
    );
  const settings = async (options = {}) => {
    const current = await service.timeSettings(admin);
    return service.saveTimeSettings(admin, {
      version: current.version,
      reviewers: { [owner.clerkUserId]: admin.clerkUserId },
      options: { ...PLANNER_DEFAULT_TIME_OPTIONS, ...options },
    });
  };
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: url! } } });
    await db.$connect();
    for (const id of [tenantId, secondTenantId])
      await db.withTenant(id, async (tx) => {
        for (const ctx of [admin, owner, other]) {
          await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,email) VALUES(${randomUUID()}::uuid,${ctx.clerkUserId},${ctx.clerkUserId},${ctx.clerkUserId + '@example.test'}) ON CONFLICT DO NOTHING`;
          await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status) SELECT ${id}::uuid,id,'active' FROM users WHERE clerk_user_id=${ctx.clerkUserId} AND NOT EXISTS(SELECT 1 FROM tenant_memberships WHERE tenant_id=${id}::uuid AND user_id=users.id)`;
        }
      });
    service = new PlannerService({ withTenant: scoped } as PrismaService, links);
  });
  beforeEach(async () => {
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`,
    );
    for (const ctx of [owner, admin, other, { ...owner, tenantId: secondTenantId }]) {
      const current = await service.timer(ctx);
      if (current) await service.discardTimer(ctx, current.id, { version: current.version });
    }
    await settings();
    for (const week of [
      plannerWeekOn(plannerTimeToday('UTC')),
      plannerWeekDate(plannerWeekOn(plannerTimeToday('UTC')), 7),
    ]) {
      const sheet = await service.timesheet(owner, { week });
      if (sheet.status === 'submitted')
        await service.transitionTimesheet(owner, {
          week,
          userId: owner.clerkUserId,
          version: sheet.version,
          revision: sheet.revision,
          action: 'recall_submission',
          notes: '',
        });
    }
  });
  afterAll(async () => db?.$disconnect());
  const task = async (members = [{ userId: owner.clerkUserId, role: 'editor' }]) => {
    const project = await service.saveProject(admin, null, {
      data: { name: 'Private timer QA ' + randomUUID(), privacy: 'private', members },
    });
    const row = await service.saveTask(admin, null, {
      data: {
        name: 'Timer task ' + randomUUID(),
        memberships: [{ projectId: project.id, sectionId: null, position: 0 }],
      },
    });
    return { project, row };
  };
  const counts = () =>
    scoped(tenantId, async (tx) => ({
      events: await tx.spPlannerEvent.count({ where: { tenantId } }),
      inbox: await tx.spPlannerInbox.count({ where: { tenantId } }),
      resources: await tx.spPlannerResource.count({ where: { tenantId } }),
    }));
  it('persists a running timer without creating time or a timesheet, then logs the correct person/defaults', async () => {
    await settings({ timeZone: 'America/New_York', billableDefault: true });
    const { project, row } = await task(),
      before = await counts();
    const input = { startKey: randomUUID(), taskId: row.id };
    const timer = await service.startTimer(owner, input, start);
    expect(timer).toMatchObject({
      version: 1,
      status: 'running',
      taskId: row.id,
      canStop: true,
      startedAt: start.toISOString(),
      time: { projectId: project.id, timeZone: 'America/New_York', billable: true },
    });
    expect((await counts()).events).toBe(before.events);
    expect((await counts()).resources).toBe(before.resources + 1);
    expect((await service.timer(owner))?.id).toBe(timer.id);
    const end = new Date(start.getTime() + 90_001),
      stopped = await service.stopTimer(owner, timer.id, { version: 1 }, end);
    expect(stopped).toMatchObject({
      status: 'stopped',
      version: 2,
      minutes: 2,
      elapsedMilliseconds: 90_001,
      canStop: false,
    });
    expect(await service.timer(owner)).toBeNull();
    const event = (await service.events(owner, { taskId: row.id })).find((e) => e.kind === 'time')!;
    expect(event).toMatchObject({
      minutes: 2,
      actorId: owner.clerkUserId,
      recordedBy: owner.clerkUserId,
      time: {
        workedOn: '2027-04-07',
        timeZone: 'America/New_York',
        projectId: project.id,
        billable: true,
      },
    });
    expect((await service.task(owner, row.id)).actualMinutes).toBe(2);
    expect((await counts()).inbox).toBe(before.inbox + 1);
  });
  it('serializes concurrent starts and stops, and keeps corrections/removals unchanged on retries', async () => {
    const { row } = await task(),
      input = { startKey: randomUUID(), taskId: row.id };
    const [a, b] = await Promise.all([
      service.startTimer(owner, input, start),
      service.startTimer(owner, input, start),
    ]);
    expect(a.id).toBe(b.id);
    await expect(
      service.startTimer(owner, { ...input, startKey: randomUUID() }, start),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.startTimer(owner, { ...input, time: { billable: true } }, start),
    ).rejects.toMatchObject({ status: 409 });
    const before = await counts(),
      body = { version: 1 },
      end = new Date(start.getTime() + 120_000);
    const stopped = await Promise.all([
      service.stopTimer(owner, a.id, body, end),
      service.stopTimer(owner, a.id, body, end),
    ]);
    expect(stopped.map((s) => s.minutes)).toEqual([2, 2]);
    expect((await counts()).events).toBe(before.events + 1);
    const event = (await service.events(owner, { taskId: row.id })).find((e) => e.kind === 'time')!;
    await service.reviseEvent(owner, event.id, { version: 0, minutes: 1 });
    await service.stopTimer(owner, a.id, body, new Date(end.getTime() + 300_000));
    expect((await service.task(owner, row.id)).actualMinutes).toBe(1);
    await service.reviseEvent(owner, event.id, { version: 1, removed: true });
    await service.stopTimer(owner, a.id, body, end);
    expect((await service.task(owner, row.id)).actualMinutes).toBe(0);
    await expect(
      service.stopTimer(owner, a.id, { version: 1, time: { billable: true } }, end),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.startTimer(owner, input, end)).status).toBe('stopped');
    expect(await service.timer(owner)).toBeNull();
  });
  it('keeps one independent session per person, and scopes reused start keys across users/tenants', async () => {
    const { row } = await task([
      { userId: owner.clerkUserId, role: 'editor' },
      { userId: other.clerkUserId, role: 'editor' },
    ]);
    const input = { startKey: randomUUID(), taskId: row.id };
    const a = await service.startTimer(owner, input, start),
      b = await service.startTimer(other, input, start);
    expect(a.id).not.toBe(b.id);
    const secondOwner = { ...owner, tenantId: secondTenantId };
    const personal = await service.saveTask(secondOwner, null, {
      data: { name: 'Separate organization timer ' + randomUUID() },
    });
    const separate = await service.startTimer(
      secondOwner,
      { ...input, taskId: personal.id },
      start,
    );
    expect(separate.id).not.toBe(a.id);
    expect((await service.timer(secondOwner))?.id).toBe(separate.id);
    expect((await service.timer(owner))?.id).toBe(a.id);
    await expect(service.stopTimer(other, a.id, { version: 1 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.discardTimer(admin, a.id, { version: 1 })).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await scoped(secondTenantId, (tx) => tx.spPlannerResource.count({ where: { id: a.id } })),
    ).toBe(0);
    await expect(
      service.stopTimer(secondOwner, a.id, {
        version: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('hides internal records from generic APIs and redacts revoked work while allowing owner discard', async () => {
    const { project, row } = await task(),
      timer = await service.startTimer(owner, { startKey: randomUUID(), taskId: row.id }, start);
    expect((await service.resources(owner)).some((r) => r.id === timer.id)).toBe(false);
    await expect(
      service.saveResource(owner, timer.id, { version: 1, archived: true }),
    ).rejects.toMatchObject({ status: 404 });
    await service.saveProject(admin, project.id, {
      version: project.version,
      data: { members: [] },
    });
    expect(await service.timer(owner)).toMatchObject({
      id: timer.id,
      taskId: null,
      taskName: null,
      time: null,
      canStop: false,
    });
    await expect(
      service.stopTimer(owner, timer.id, { version: 1 }, new Date(start.getTime() + 60_000)),
    ).rejects.toMatchObject({ status: 404 });
    const discarded = await service.discardTimer(owner, timer.id, { version: 1 });
    expect(discarded.status).toBe('discarded');
    expect((await service.discardTimer(owner, timer.id, { version: 1 })).status).toBe('discarded');
    expect(await service.timer(owner)).toBeNull();
    await expect(service.stopTimer(owner, timer.id, { version: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('requires editor grants and active membership, with no organization-admin bypass', async () => {
    const { row } = await task([{ userId: owner.clerkUserId, role: 'viewer' }]);
    await expect(
      service.startTimer(owner, { startKey: randomUUID(), taskId: row.id }, start),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.startTimer(
        { ...other, role: 'org:admin' },
        { startKey: randomUUID(), taskId: row.id },
        start,
      ),
    ).rejects.toMatchObject({ status: 404 });
    const own = await task(),
      timer = await service.startTimer(
        owner,
        { startKey: randomUUID(), taskId: own.row.id },
        start,
      );
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id=(SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
    );
    await expect(service.timer(owner)).rejects.toMatchObject({ status: 404 });
    await expect(service.stopTimer(owner, timer.id, { version: 1 })).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.discardTimer(owner, timer.id, { version: 1 })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('requires explicit multi-project allocation and applies billable/category overrides at stop', async () => {
    const a = await task(),
      b = await task();
    const multi = await service.saveTask(admin, a.row.id, {
      version: a.row.version,
      data: {
        memberships: [
          { projectId: a.project.id, sectionId: null, position: 0 },
          { projectId: b.project.id, sectionId: null, position: 0 },
        ],
      },
    });
    const input = { startKey: randomUUID(), taskId: multi.id };
    await expect(service.startTimer(owner, input, start)).rejects.toMatchObject({ status: 400 });
    const timer = await service.startTimer(
      owner,
      { ...input, time: { projectId: a.project.id } },
      start,
    );
    await settings({ categories: ['Delivery'] });
    await expect(
      service.stopTimer(
        owner,
        timer.id,
        { version: 1, time: { timeZone: 'Europe/London' } },
        start,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await service.stopTimer(
      owner,
      timer.id,
      { version: 1, time: { projectId: b.project.id, category: 'Delivery', billable: true } },
      new Date(start.getTime() + 60_000),
    );
    const event = (await service.events(owner, { taskId: multi.id })).find(
      (e) => e.kind === 'time',
    )!;
    expect(event.time).toMatchObject({
      projectId: b.project.id,
      category: 'Delivery',
      billable: true,
      timeZone: 'UTC',
    });
  });
  it('splits complete elapsed work by captured local dates and batches a 25-hour day into normal entries', async () => {
    const { row } = await task();
    const timer = await service.startTimer(
      owner,
      { startKey: randomUUID(), taskId: row.id, time: { timeZone: 'America/New_York' } },
      new Date('2026-11-01T04:00:00Z'),
    );
    await service.stopTimer(owner, timer.id, { version: 1 }, new Date('2026-11-02T05:01:00Z'));
    const events = (await service.events(owner, { taskId: row.id })).filter(
      (e) => e.kind === 'time',
    );
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.minutes! <= 1440)).toBe(true);
    expect(
      events.filter((e) => e.time?.workedOn === '2026-11-01').reduce((n, e) => n + e.minutes!, 0),
    ).toBe(1500);
    expect(events.find((e) => e.time?.workedOn === '2026-11-02')?.minutes).toBe(1);
    expect((await service.task(owner, row.id)).actualMinutes).toBe(1501);
  });
  it('retains a running session with no partial entries when time policy or submitted weeks reject stopping', async () => {
    const { row } = await task();
    const monday = plannerWeekOn(plannerTimeToday('UTC')),
      nextWeek = plannerWeekDate(monday, 7),
      sunday = plannerWeekDate(monday, 6),
      stamp = new Date(`${sunday}T23:59:00Z`);
    // Both weeks need existing time for the normal submission flow to be available.
    for (const workedOn of [sunday, nextWeek])
      await service.addEvent(
        owner,
        { taskId: row.id },
        {
          kind: 'time',
          text: 'Synthetic approval-lock baseline',
          minutes: 1,
          time: { workedOn, timeZone: 'UTC' },
        },
      );
    const timer = await service.startTimer(
      owner,
      { startKey: randomUUID(), taskId: row.id },
      stamp,
    );
    const before = await counts();
    await settings({ timeTrackingEnabled: false });
    await expect(
      service.stopTimer(owner, timer.id, { version: 1 }, new Date(stamp.getTime() + 120_000)),
    ).rejects.toMatchObject({ status: 403 });
    expect((await counts()).events).toBe(before.events);
    await settings({ approvalProcess: 'simple' });
    const firstWeek = await service.timesheet(owner, { week: monday });
    const sheet = await service.timesheet(owner, { week: nextWeek });
    await service.transitionTimesheet(owner, {
      week: nextWeek,
      userId: owner.clerkUserId,
      version: sheet.version,
      revision: sheet.revision,
      action: 'submit',
      notes: '',
    });
    const beforeRejectedStop = await counts();
    await expect(
      service.stopTimer(owner, timer.id, { version: 1 }, new Date(stamp.getTime() + 120_000)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual(beforeRejectedStop);
    expect((await service.timer(owner))?.id).toBe(timer.id);
    expect((await service.timesheet(owner, { week: monday })).version).toBe(firstWeek.version);
    const locked = await service.timesheet(owner, { week: nextWeek });
    await service.transitionTimesheet(owner, {
      week: nextWeek,
      userId: owner.clerkUserId,
      version: locked.version,
      revision: locked.revision,
      action: 'recall_submission',
      notes: '',
    });
    await service.stopTimer(owner, timer.id, { version: 1 }, new Date(stamp.getTime() + 120_000));
  });
  it('rejects malformed timestamps/fields, policy/allocation violations and stale versions without partial writes', async () => {
    const { row } = await task(),
      input = { startKey: randomUUID(), taskId: row.id };
    for (const time of [
      { timeZone: 'Bad/Zone' },
      { workedOn: '2027-04-07' },
      { billable: 'yes' },
      { projectId: randomUUID() },
    ])
      await expect(service.startTimer(owner, { ...input, time }, start)).rejects.toMatchObject({
        status: 400,
      });
    for (const field of ['startedAt', 'endedAt', 'clock', 'loggerId', 'minutes'])
      await expect(
        service.startTimer(owner, { ...input, [field]: 'forged' }, start),
      ).rejects.toMatchObject({ status: 400 });
    expect(await service.timer(owner)).toBeNull();
    await settings({ billableEnabled: false });
    await expect(
      service.startTimer(owner, { ...input, time: { billable: true } }, start),
    ).rejects.toMatchObject({ status: 403 });
    const timer = await service.startTimer(owner, input, start),
      before = await counts();
    await expect(service.stopTimer(owner, timer.id, { version: 0 })).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.stopTimer(owner, timer.id, { version: 2 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.stopTimer(owner, timer.id, { version: 1 }, new Date(start.getTime() - 1)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toEqual(before);
    expect((await service.discardTimer(owner, timer.id, { version: 1 })).minutes).toBe(0);
  });
  it('rolls back time, timesheets and notifications if the final private receipt cannot commit', async () => {
    const { row } = await task(),
      timer = await service.startTimer(owner, { startKey: randomUUID(), taskId: row.id }, start);
    const failing = new PlannerService(
      {
        withTenant: <T>(
          id: string,
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: Parameters<PrismaService['withTenant']>[2],
        ) =>
          scoped(
            id,
            (tx) =>
              run(
                new Proxy(tx, {
                  get(target, key) {
                    if (key !== 'spPlannerResource') return Reflect.get(target, key);
                    return new Proxy(target.spPlannerResource, {
                      get(delegate, name) {
                        if (name !== 'update') return Reflect.get(delegate, name);
                        return (args: Prisma.SpPlannerResourceUpdateArgs) =>
                          args.where.id === timer.id
                            ? Promise.reject(Error('Synthetic timer receipt failure'))
                            : delegate.update(args);
                      },
                    });
                  },
                }),
              ),
            options,
          ),
      } as PrismaService,
      links,
    );
    const before = await counts();
    await expect(
      failing.stopTimer(owner, timer.id, { version: 1 }, new Date(start.getTime() + 120_000)),
    ).rejects.toThrow('Synthetic timer receipt failure');
    expect(await counts()).toEqual(before);
    expect((await service.timer(owner))?.version).toBe(1);
    await service.stopTimer(owner, timer.id, { version: 1 }, new Date(start.getTime() + 120_000));
  });
});
