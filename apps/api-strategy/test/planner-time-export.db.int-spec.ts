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
  if (!['127.0.0.1', 'localhost'].includes(u.hostname) || u.pathname !== '/planner_qa')
    throw Error('Exports require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000034';
const admin: AuthTenantContext = { tenantId, clerkUserId: 'user_export_admin', role: 'org:admin' };
const owner = { ...admin, clerkUserId: 'user_export_owner', role: 'org:member' };
const reviewer = { ...owner, clerkUserId: 'user_export_reviewer' };
const other = { ...owner, clerkUserId: 'user_export_other' };
const base = plannerWeekOn(`${2040 + Math.floor(Math.random() * 5000)}-01-07`);
let index = 0;
describeDb('Complete date-range exports under forced tenant security', () => {
  let db: PrismaService, service: PlannerService, fromOn: string, throughOn: string;
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
  const settings = async (reviewers: Record<string, string>) => {
    const old = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, { version: old.version, reviewers });
  };
  beforeEach(async () => {
    fromOn = plannerWeekDate(base, index++ * 70);
    throughOn = plannerWeekDate(fromOn, 40);
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`,
    );
    await settings({ [owner.clerkUserId]: reviewer.clerkUserId });
  });
  afterAll(async () => db?.$disconnect());
  const work = async (share = true) => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Export QA ' + randomUUID(),
        privacy: 'private',
        members: share
          ? [
              { userId: reviewer.clerkUserId, role: 'viewer' },
              { userId: other.clerkUserId, role: 'editor' },
            ]
          : [],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Export work',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    return { p, t };
  };
  const query = (scope = 'personal') => ({ scope, fromOn, throughOn });
  const log = (taskId: string, workedOn = fromOn, minutes = 60, ctx = owner) =>
    service.addEvent(
      ctx,
      { taskId },
      {
        kind: 'time',
        text: 'Export time',
        minutes,
        time: { workedOn, billable: true, timeZone: 'America/New_York' },
      },
    );
  it('exports the inclusive range across weeks with latest immutable corrections, allocation and current task status', async () => {
    const { p, t } = await work(),
      a = await log(t.id),
      b = await log(t.id, throughOn, 30),
      removed = await log(t.id);
    await log(t.id, plannerWeekDate(fromOn, -1));
    await log(t.id, plannerWeekDate(throughOn, 1));
    await service.reviseEvent(owner, a.id, {
      version: 0,
      text: 'Corrected',
      minutes: 90,
      time: {
        workedOn: plannerWeekDate(fromOn, 10),
        billable: false,
        timeZone: 'America/New_York',
        projectId: p.id,
        category: '',
      },
    });
    await service.reviseEvent(owner, removed.id, { version: 0, removed: true });
    await service.saveTask(owner, t.id, { version: t.version, data: { status: 'done' } });
    const result = await service.timeExport(owner, query());
    expect(result.items.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(result.totalMinutes).toBe(120);
    expect(result.billableMinutes).toBe(30);
    expect(result.items[0]).toMatchObject({
      taskId: t.id,
      taskName: 'Export work',
      taskStatus: 'Completed',
      submitterName: owner.clerkUserId,
      version: 1,
      minutes: 90,
      time: { workedOn: plannerWeekDate(fromOn, 10), projectId: p.id, billable: false },
    });
    const project = await service.timeExport(reviewer, { ...query('project'), projectId: p.id });
    expect(project.items.map((e) => e.id)).toEqual([a.id, b.id]);
  });
  it('exports every page in stable date and ID order and rejects changed data and foreign cursors', async () => {
    const { t, p } = await work();
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.spPlannerEvent.createMany({
        data: Array.from({ length: 121 }, (_, i) => ({
          id: randomUUID(),
          tenantId,
          taskId: t.id,
          actorId: owner.clerkUserId,
          kind: 'time',
          text: 'Page ' + i,
          minutes: 10,
          details: {
            time: {
              workedOn: plannerWeekDate(fromOn, i % 35),
              timeZone: 'UTC',
              billable: true,
              projectId: p.id,
              category: '',
            },
          },
        })),
      });
    });
    const first = await service.timeExport(owner, query());
    expect(first.matched).toBe(121);
    expect(first.items).toHaveLength(100);
    expect(first.totalMinutes).toBe(1210);
    const last = await service.timeExport(owner, {
      ...query(),
      cursor: first.nextCursor!,
      revision: first.revision,
    });
    expect(last.items).toHaveLength(21);
    expect(last.nextCursor).toBeNull();
    const all = [...first.items, ...last.items];
    expect(new Set(all.map((e) => e.id)).size).toBe(121);
    expect(all).toEqual(
      [...all].sort(
        (a, b) => a.time.workedOn.localeCompare(b.time.workedOn) || a.id.localeCompare(b.id),
      ),
    );
    await expect(
      service.timeExport(owner, { ...query(), cursor: randomUUID(), revision: first.revision }),
    ).rejects.toMatchObject({ status: 400 });
    await service.reviseEvent(owner, last.items[0]!.id, { version: 0, removed: true });
    await expect(
      service.timeExport(owner, { ...query(), revision: first.revision }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('allows only current assigned submitters; org admins have no private time bypass', async () => {
    const { t } = await work();
    await log(t.id);
    const personal = await service.timeExport(reviewer, { ...query(), userId: owner.clerkUserId });
    expect(personal.matched).toBe(1);
    const all = await service.timeExport(reviewer, query('review'));
    expect(all.matched).toBe(1);
    await expect(
      service.timeExport(admin, { ...query(), userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.timeExport(admin, query('review'))).matched).toBe(0);
    await settings({});
    await expect(
      service.timeExport(reviewer, { ...query(), userId: owner.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.timeExport(reviewer, { ...query('review'), revision: all.revision }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rechecks task and historical project access for reviewers and project readers on every page', async () => {
    const { p, t } = await work();
    await log(t.id);
    const first = await service.timeExport(reviewer, query('review'));
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(
      service.timeExport(reviewer, { ...query('review'), revision: first.revision }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await service.timeExport(reviewer, query('review'));
    expect(fresh.items).toEqual([]);
    expect(fresh.unavailableEntries).toBe(true);
    expect(fresh.totalMinutes).toBe(0);
    await expect(
      service.timeExport(reviewer, { ...query('project'), projectId: p.id }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.timeExport(admin, { ...query('project'), projectId: p.id }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('keeps historical project allocation after task movement and invalidates changed names or status', async () => {
    const { p, t } = await work(),
      e = await log(t.id),
      second = await work();
    const before = await service.timeExport(reviewer, { ...query('project'), projectId: p.id });
    await service.saveTask(owner, t.id, {
      version: t.version,
      data: {
        name: 'Moved work',
        memberships: [{ projectId: second.p.id, sectionId: null, position: 0 }],
      },
    });
    await expect(
      service.timeExport(reviewer, {
        ...query('project'),
        projectId: p.id,
        revision: before.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await service.timeExport(reviewer, { ...query('project'), projectId: p.id })).items[0],
    ).toMatchObject({ id: e.id, taskName: 'Moved work', time: { projectId: p.id } });
    expect(
      (await service.timeExport(reviewer, { ...query('project'), projectId: second.p.id })).matched,
    ).toBe(0);
  });
  it('retains departed submitters in readable project history but excludes inactive review targets and callers', async () => {
    const { p, t } = await work();
    await log(t.id);
    const before = await service.timeExport(reviewer, query('review'));
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id=(SELECT id FROM users WHERE clerk_user_id=${owner.clerkUserId})`,
    );
    await expect(
      service.timeExport(reviewer, { ...query('review'), revision: before.revision }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.timeExport(reviewer, query('review'))).matched).toBe(0);
    expect(
      (await service.timeExport(reviewer, { ...query('project'), projectId: p.id })).items[0]
        ?.submitterName,
    ).toBe('Former member');
    await expect(service.timeExport(owner, query())).rejects.toMatchObject({ status: 404 });
  });
  it('includes general project work and every project submitter while keeping personal and reviewer exports scoped', async () => {
    const { p, t } = await work();
    await log(t.id, fromOn, 60);
    await log(t.id, fromOn, 30, other);
    const general = await service.addEvent(
      owner,
      { projectId: p.id },
      { kind: 'time', text: 'General planning', minutes: 15, time: { workedOn: throughOn } },
    );
    const project = await service.timeExport(reviewer, { ...query('project'), projectId: p.id });
    expect(project.totalMinutes).toBe(105);
    expect(project.items.find((e) => e.id === general.id)).toMatchObject({
      taskId: null,
      taskName: null,
      taskStatus: null,
    });
    expect((await service.timeExport(owner, query())).totalMinutes).toBe(75);
    expect((await service.timeExport(reviewer, query('review'))).totalMinutes).toBe(75);
    await expect(
      service.timeExport(reviewer, { ...query(), userId: other.clerkUserId }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('moves corrected entries into and out of date ranges and aborts a now-stale export', async () => {
    const { t, p } = await work(),
      e = await log(t.id, plannerWeekDate(fromOn, -1));
    expect((await service.timeExport(owner, query())).matched).toBe(0);
    await service.reviseEvent(owner, e.id, {
      version: 0,
      time: { workedOn: fromOn, projectId: p.id, timeZone: 'UTC', billable: false, category: '' },
    });
    const before = await service.timeExport(owner, query());
    expect(before.items[0]?.id).toBe(e.id);
    await service.reviseEvent(owner, e.id, {
      version: 1,
      time: {
        workedOn: plannerWeekDate(throughOn, 1),
        projectId: p.id,
        timeZone: 'UTC',
        billable: false,
        category: '',
      },
    });
    await expect(
      service.timeExport(owner, { ...query(), revision: before.revision }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.timeExport(owner, query())).matched).toBe(0);
  });
  it('allows an admin organization export only for readable sources, without revealing unrelated private work', async () => {
    const shared = await work(),
      hidden = await work(false);
    await log(shared.t.id, fromOn, 30);
    await log(hidden.t.id, fromOn, 90);
    await service.saveProject(owner, shared.p.id, {
      version: shared.p.version,
      data: { members: [{ userId: admin.clerkUserId, role: 'viewer' }] },
    });
    const exported = await service.timeExport(admin, query('organization'));
    expect(exported.matched).toBe(1);
    expect(exported.totalMinutes).toBe(30);
    expect(exported.unavailableEntries).toBe(false);
    expect(JSON.stringify(exported)).not.toContain(hidden.p.id);
    expect(JSON.stringify(exported)).not.toContain(hidden.t.id);
    await expect(service.timeExport(owner, query('organization'))).rejects.toMatchObject({
      status: 403,
    });
    await service.saveProject(owner, shared.p.id, {
      version: shared.p.version + 1,
      data: { members: [] },
    });
    await expect(
      service.timeExport(admin, { ...query('organization'), revision: exported.revision }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.timeExport(admin, query('organization'))).matched).toBe(0);
  });
  it('isolates tenants and rejects invalid ranges, selectors and unbound pagination', async () => {
    const { p, t } = await work();
    await log(t.id);
    await expect(
      service.timeExport(
        { ...owner, tenantId: '10000000-0000-4000-8000-000000000035' },
        { ...query('project'), projectId: p.id },
      ),
    ).rejects.toMatchObject({ status: 404 });
    for (const q of [
      { ...query(), fromOn: '2026-02-30' },
      { ...query(), throughOn: plannerWeekDate(fromOn, -1) },
      { ...query(), cursor: randomUUID() },
      { ...query('review'), userId: owner.clerkUserId },
      { ...query('project') },
      { ...query(), scope: 'invalid' },
      { ...query(), fromOn: [fromOn] },
    ])
      await expect(service.timeExport(owner, q as any)).rejects.toMatchObject({ status: 400 });
  });
});
