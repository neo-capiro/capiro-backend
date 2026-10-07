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
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const u = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/planner_qa')
    throw Error('Time imports require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000036';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_import_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_import_owner', role: 'org:member' };
const other = { ...owner, clerkUserId: 'user_import_other' };
const base = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
let index = 0;
describeDb('Reviewed time CSV imports under restricted database privileges', () => {
  let db: PrismaService, service: PlannerService, week: string;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const ctx of [admin, owner, other]) {
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
  const settings = async (options = {}) => {
    const old = await service.timeSettings(admin);
    return service.saveTimeSettings(admin, {
      version: old.version,
      reviewers: { [owner.clerkUserId]: other.clerkUserId },
      options: { ...PLANNER_DEFAULT_TIME_OPTIONS, ...options },
    });
  };
  beforeEach(async () => {
    week = plannerWeekDate(base, index++ * 14);
    await settings();
    // The default-date assertion uses today's real week; recover any lock from
    // an earlier interrupted run in this dedicated fixture before exercising it.
    const currentWeek = plannerWeekOn(plannerTimeToday('UTC'));
    const current = await service.timesheet(owner, { week: currentWeek });
    if (current.status === 'submitted')
      await service.transitionTimesheet(owner, {
        week: currentWeek,
        userId: owner.clerkUserId,
        version: current.version,
        revision: current.revision,
        action: 'recall_submission',
        notes: '',
      });
  });
  afterAll(async () => db?.$disconnect());
  const project = () =>
    service.saveProject(owner, null, {
      data: {
        name: 'CSV QA ' + randomUUID(),
        privacy: 'private',
        members: [{ userId: other.clerkUserId, role: 'viewer' }],
      },
    });
  const input = (projectId?: string, actualMinutes = 90) => ({
    importKey: randomUUID(),
    data: {
      name: 'CSV task ' + randomUUID(),
      estimateMinutes: 135,
      memberships: projectId ? [{ projectId, sectionId: null, position: 0 }] : [],
    },
    actualMinutes,
    time: { workedOn: week, timeZone: 'UTC' },
  });
  const counts = () =>
    db.withTenant(tenantId, async (tx) => ({
      tasks: await tx.spPlannerTask.count({ where: { tenantId } }),
      events: await tx.spPlannerEvent.count({ where: { tenantId } }),
      receipts: await tx.spPlannerResource.count({
        where: { tenantId, kind: 'task_import_receipt' },
      }),
    }));
  it('records estimates and actual time using the importer, reviewed date, allocation and billable defaults', async () => {
    await settings({ billableDefault: true, timeZone: 'America/New_York' });
    const p = await project(),
      row = input(p.id),
      t = await service.importTask(owner, row);
    expect(t).toMatchObject({ estimateMinutes: 135, actualMinutes: 90 });
    const events = await service.events(owner, { taskId: t.id });
    const e = events.find((e) => e.kind === 'time')!;
    expect(e).toMatchObject({
      actorId: owner.clerkUserId,
      recordedBy: owner.clerkUserId,
      minutes: 90,
      time: { workedOn: week, timeZone: 'UTC', billable: true, projectId: p.id },
    });
    await service.reviseEvent(owner, e.id, { version: 0, minutes: 25 });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(25);
    await service.reviseEvent(owner, e.id, { version: 1, removed: true });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(0);
    const retry = await service.importTask(owner, row);
    expect(retry.id).toBe(t.id);
    expect(retry.actualMinutes).toBe(0);
    const defaults = await service.importTask(owner, { ...input(), time: undefined });
    expect(
      (await service.events(owner, { taskId: defaults.id })).find((e) => e.kind === 'time')?.time,
    ).toMatchObject({
      workedOn: plannerTimeToday('America/New_York'),
      timeZone: 'America/New_York',
      billable: true,
      projectId: null,
    });
  });
  it('imports large totals in one batch of correctable entries without exceeding the entry limit', async () => {
    const row = input(undefined, 1_000_000),
      t = await service.importTask(owner, row);
    expect(t.actualMinutes).toBe(1_000_000);
    const events = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.findMany({ where: { tenantId, taskId: t.id, kind: 'time' } }),
    );
    expect(events).toHaveLength(Math.ceil(1_000_000 / 1440));
    expect(events.every((e) => e.minutes! > 0 && e.minutes! <= 1440)).toBe(true);
    expect(events.reduce((n, e) => n + e.minutes!, 0)).toBe(1_000_000);
  });
  it('deduplicates concurrent/lost-response retries and rejects reusing a key for different values', async () => {
    const row = input(),
      before = await counts();
    const [a, b] = await Promise.all([
      service.importTask(owner, row),
      service.importTask(owner, row),
    ]);
    expect(a.id).toBe(b.id);
    expect(await counts()).toEqual({
      tasks: before.tasks + 1,
      events: before.events + 2,
      receipts: before.receipts + 1,
    });
    await expect(service.importTask(owner, { ...row, actualMinutes: 91 })).rejects.toMatchObject({
      status: 409,
    });
    await expect(service.importTask(other, row)).rejects.toMatchObject({ status: 404 });
  });
  it('keeps receipts outside generic resources and rechecks source permissions on replay', async () => {
    const p = await project(),
      row = input(p.id),
      t = await service.importTask(owner, row);
    expect((await service.resources(owner)).some((r) => r.id === row.importKey)).toBe(false);
    await expect(
      service.saveResource(owner, row.importKey, { version: 1, name: 'Tamper' }),
    ).rejects.toMatchObject({ status: 404 });
    const latest = await service.task(owner, t.id);
    await service.saveTask(owner, t.id, {
      version: latest.version,
      data: {
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
        assigneeId: other.clerkUserId,
      },
    });
    const p2 = await service.saveProject(other, null, {
      data: { name: 'Moved private task', privacy: 'private' },
    });
    await db.withTenant(tenantId, async (tx) => {
      const task = await tx.spPlannerTask.findFirst({ where: { tenantId, id: t.id } });
      const data = {
        ...(task!.data as object),
        memberships: [{ projectId: p2.id, sectionId: null, position: 0 }],
      };
      await tx.spPlannerTask.update({
        where: { id: t.id, tenantId },
        data: { projectIds: [p2.id], data },
      });
    });
    await expect(service.importTask(owner, row)).rejects.toMatchObject({ status: 404 });
    const foreign = await db.withTenant('10000000-0000-4000-8000-000000001036', async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return tx.$queryRaw`SELECT id FROM sp_planner_resources WHERE id=${row.importKey}::uuid`;
    });
    expect(foreign).toEqual([]);
  });
  it('enforces project access, active membership and input bounds without creating partial records', async () => {
    const p = await project();
    const before = await counts();
    await expect(service.importTask(other, input(p.id))).rejects.toMatchObject({ status: 403 });
    await expect(service.importTask(admin, input(p.id))).rejects.toMatchObject({ status: 404 });
    for (const actualMinutes of [-1, 0.5, 1_000_001])
      await expect(
        service.importTask(owner, input(undefined, actualMinutes)),
      ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.importTask(owner, { ...input(), loggerId: other.clerkUserId }),
    ).rejects.toMatchObject({ status: 400 });
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id IN(SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
    );
    try {
      await expect(service.importTask(owner, input())).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.withTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid AND user_id IN(SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
      );
    }
    expect(await counts()).toEqual(before);
  });
  it('rolls back creation and receipt when allocation or organization time policy rejects the time', async () => {
    const p = await project(),
      row = input(),
      before = await counts();
    await expect(
      service.importTask(owner, { ...row, time: { ...row.time, projectId: p.id } }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await counts()).toEqual(before);
    await settings({ timeTrackingEnabled: false });
    await expect(service.importTask(owner, row)).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual(before);
    await settings({ futureWeeks: 0 });
    await expect(service.importTask(owner, row)).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual(before);
  });
  it('rejects a locked timesheet atomically and allows zero-time imports without tracking', async () => {
    await settings({ approvalProcess: 'simple' });
    const t = await service.importTask(owner, input());
    const sheet = await service.timesheet(owner, { week });
    await service.transitionTimesheet(owner, {
      week,
      userId: owner.clerkUserId,
      version: sheet.version,
      revision: sheet.revision,
      action: 'submit',
      notes: '',
    });
    expect((await service.timesheet(owner, { week })).status).toBe('submitted');
    const before = await counts();
    await expect(service.importTask(owner, input())).rejects.toMatchObject({ status: 403 });
    expect(await counts()).toEqual(before);
    await settings({ timeTrackingEnabled: false });
    const row = { ...input(undefined, 0), data: { name: 'No time' } };
    const zero = await service.importTask(owner, row);
    expect(zero.actualMinutes).toBe(0);
    expect((await service.importTask(owner, row)).id).toBe(zero.id);
    expect(t.actualMinutes).toBe(90);
  });
});
