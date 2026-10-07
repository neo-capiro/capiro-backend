import { randomUUID } from 'node:crypto';
import { PLANNER_DEFAULT_PROJECT, plannerDefaultBudget } from '@capiro/strategy-verifier';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const u = new URL(testUrl);
  if (!['localhost', '127.0.0.1'].includes(u.hostname) || u.pathname !== '/planner_qa')
    throw Error('Budgets require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000035';
const owner: AuthTenantContext = { tenantId, clerkUserId: 'user_budget_owner', role: 'org:member' };
const other = { ...owner, clerkUserId: 'user_budget_other' },
  viewer = { ...owner, clerkUserId: 'user_budget_viewer' },
  admin = { ...owner, clerkUserId: 'user_budget_orgadmin', role: 'org:admin' };
describeDb('Private project budgets under the restricted runtime role', () => {
  let db: PrismaService, service: PlannerService;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    await db.withTenant(tenantId, async (tx) => {
      for (const ctx of [owner, other, viewer, admin]) {
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
  beforeEach(async () => {
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
      await tx.spPlannerResource.updateMany({
        where: { tenantId, kind: 'project_budget_alert' },
        data: { archived: true },
      });
    });
    const settings = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: settings.version,
      reviewers: settings.reviewers,
      options: { budgetCurrency: 'USD', pastLockWeeks: null, futureWeeks: null },
    });
  });
  afterAll(async () => db?.$disconnect());
  const project = async (
    ctx = owner,
    members = [
      { userId: other.clerkUserId, role: 'editor' },
      { userId: viewer.clerkUserId, role: 'viewer' },
    ],
  ) =>
    service.saveProject(ctx, null, {
      data: { name: 'Budget QA ' + randomUUID(), privacy: 'private', members },
    });
  const task = async (
    projectId: string,
    assigneeId: string | null = owner.clerkUserId,
    minutes = 120,
  ) =>
    service.saveTask(owner, null, {
      data: {
        name: 'Budget work',
        assigneeId,
        estimateMinutes: minutes,
        memberships: [{ projectId, sectionId: null, position: 0 }],
      },
    });
  const log = async (
    taskId: string,
    projectId: string,
    minutes = 60,
    billable = true,
    ctx = owner,
  ) =>
    service.addEvent(
      ctx,
      { taskId },
      {
        kind: 'time',
        text: 'Budget QA time',
        minutes,
        time: { workedOn: '2026-10-07', timeZone: 'UTC', projectId, billable },
      },
    );
  const rate = async (projectId: string, rate = '10000') => {
    const b = await service.projectBudget(owner, projectId);
    return service.saveProjectBudget(owner, projectId, {
      version: b.version,
      data: {
        measurement: 'cost',
        budgetMinor: '10000',
        rates: [{ userId: owner.clerkUserId, hourlyMinor: rate }],
      },
    });
  };
  const alert = async (projectId: string, ctx = owner) => {
    const b = await service.projectBudget(ctx, projectId);
    return service.saveBudgetAlert(ctx, projectId, {
      version: b.alert.version,
      data: { enabled: true, percent: 80, comparison: 'budget' },
    });
  };
  it('allows project admins only, with no organization admin bypass or public financial JSON', async () => {
    const p = await project();
    await rate(p.id);
    for (const ctx of [other, viewer, admin]) {
      const status = ctx === admin ? 404 : 403;
      await expect(service.projectBudget(ctx, p.id)).rejects.toMatchObject({ status });
      await expect(
        service.saveProjectBudget(ctx, p.id, { version: 1, data: { budgetMinor: '1' } }),
      ).rejects.toMatchObject({ status });
      await expect(
        service.saveBudgetAlert(ctx, p.id, {
          version: 0,
          data: { enabled: true, percent: 80, comparison: 'budget' },
        }),
      ).rejects.toMatchObject({ status });
    }
    const resources = await service.resources(owner);
    expect(resources.some((r) => (r.kind as string) === 'project_budget')).toBe(false);
    const bootstrap = await service.bootstrap(other);
    expect(JSON.stringify(bootstrap)).not.toContain('hourlyMinor');
    const row = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerResource.findFirst({
        where: { tenantId, kind: 'project_budget', projectId: p.id },
      }),
    );
    await expect(
      service.saveResource(owner, row!.id, { version: row!.version, name: 'Generic edit' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.projectBudget({ ...owner, tenantId: '10000000-0000-4000-8000-000000000001' }, p.id),
    ).rejects.toThrow();
  });
  it('uses latest corrections and removals, general project time and billable filters', async () => {
    const p = await project(),
      t = await task(p.id),
      a = await log(t.id, p.id),
      removed = await log(t.id, p.id);
    await service.reviseEvent(owner, a.id, { version: 0, minutes: 30, time: { billable: false } });
    await service.reviseEvent(owner, removed.id, { version: 0, removed: true });
    await service.addEvent(
      owner,
      { projectId: p.id },
      {
        kind: 'time',
        text: 'General project',
        minutes: 20,
        time: { workedOn: '2026-10-07', timeZone: 'UTC', projectId: p.id, billable: true },
      },
    );
    const b = await rate(p.id);
    expect(b).toMatchObject({
      estimatedMinutes: 120,
      actualMinutes: 50,
      billableMinutes: 20,
      nonbillableMinutes: 30,
      estimatedMinor: '20000',
      actualMinor: '8333',
    });
    const filtered = await service.saveProjectBudget(owner, p.id, {
      version: b.version,
      data: { actualFilter: 'billable' },
    });
    expect(filtered).toMatchObject({
      estimatedMinutes: 120,
      actualMinutes: 20,
      actualMinor: '3333',
      nonbillableMinutes: 30,
    });
  });
  it('keeps multi-project estimates but allocates actual work to only its recorded project', async () => {
    const a = await project(),
      b = await project(),
      t = await task(a.id);
    await service.saveTask(owner, t.id, {
      version: t.version,
      data: {
        memberships: [
          { projectId: a.id, sectionId: null, position: 0 },
          { projectId: b.id, sectionId: null, position: 0 },
        ],
      },
    });
    const e = await log(t.id, a.id);
    await rate(a.id);
    await rate(b.id);
    expect(await service.projectBudget(owner, a.id)).toMatchObject({
      estimatedMinutes: 120,
      actualMinutes: 60,
    });
    expect(await service.projectBudget(owner, b.id)).toMatchObject({
      estimatedMinutes: 120,
      actualMinutes: 0,
    });
    await service.reviseEvent(owner, e.id, { version: 0, time: { projectId: b.id } });
    expect(await service.projectBudget(owner, a.id)).toMatchObject({ actualMinutes: 0 });
    expect(await service.projectBudget(owner, b.id)).toMatchObject({ actualMinutes: 60 });
  });
  it('filters moved task history after its current grant is revoked but retains readable archived history', async () => {
    const a = await project(),
      t = await task(a.id, other.clerkUserId);
    await log(t.id, a.id);
    await rate(a.id);
    await service.saveTask(owner, t.id, { version: t.version, archived: true });
    expect(await service.projectBudget(owner, a.id)).toMatchObject({
      estimatedMinutes: 0,
      actualMinutes: 60,
    });
    const restored = await service.saveTask(owner, t.id, {
      version: t.version + 1,
      archived: false,
    });
    const b = await project(other, [{ userId: owner.clerkUserId, role: 'editor' }]);
    await service.saveTask(owner, t.id, {
      version: restored.version,
      data: { memberships: [{ projectId: b.id, sectionId: null, position: 0 }] },
    });
    expect(await service.projectBudget(owner, a.id)).toMatchObject({
      estimatedMinutes: 0,
      actualMinutes: 60,
    });
    await service.saveProject(other, b.id, { version: b.version, data: { members: [] } });
    expect(await service.projectBudget(owner, a.id)).toMatchObject({
      actualMinutes: 0,
      actualMinor: '0',
    });
  });
  it('retains former member rates and names without changing project membership', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id, p.id, 60, true, other);
    const b = await service.saveProjectBudget(owner, p.id, {
      version: 0,
      data: { rates: [{ userId: other.clerkUserId, hourlyMinor: '5000' }] },
    });
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id IN (SELECT id FROM users WHERE clerk_user_id=${other.clerkUserId})`,
    );
    const next = await service.saveProjectBudget(owner, p.id, {
      version: b.version,
      data: { rates: [{ userId: other.clerkUserId, hourlyMinor: '6000', name: 'Injected' }] },
    });
    expect(next.people.find((p) => p.userId === other.clerkUserId)).toMatchObject({
      active: false,
      name: other.clerkUserId,
      actualMinor: '6000',
    });
    expect((await service.bootstrap(owner)).projects.find((x) => x.id === p.id)?.members).toEqual(
      p.members,
    );
  });
  it('returns a version conflict after competing budget updates and snapshots default currency', async () => {
    const p = await project();
    const attempts = await Promise.allSettled(
      ['1000', '2000'].map((hourlyMinor) =>
        service.saveProjectBudget(owner, p.id, {
          version: 0,
          data: { rates: [{ userId: owner.clerkUserId, hourlyMinor }] },
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (attempts.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status,
    ).toBe(409);
    const settings = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: settings.version,
      reviewers: settings.reviewers,
      options: { budgetCurrency: 'EUR' },
    });
    expect((await service.projectBudget(owner, p.id)).data.currency).toBe('USD');
    const second = await project();
    expect((await rate(second.id)).data.currency).toBe('EUR');
  });
  it('rolls portfolios up through current project admin grants with separate currencies', async () => {
    const a = await project(),
      b = await project(other, [{ userId: owner.clerkUserId, role: 'viewer' }]);
    await task(a.id);
    await rate(a.id);
    const settings = await service.timeSettings(admin);
    await service.saveTimeSettings(admin, {
      version: settings.version,
      reviewers: settings.reviewers,
      options: { budgetCurrency: 'EUR' },
    });
    const c = await project();
    await task(c.id);
    await rate(c.id);
    const portfolio = await service.saveResource(owner, null, {
      kind: 'portfolio',
      name: 'Budget portfolio',
      data: {
        description: '',
        privacy: 'private',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
        projectIds: [a.id, b.id, c.id],
      },
    });
    const result = await service.portfolioBudgets(owner, portfolio.id);
    expect(result.projects.map((p) => p.projectId).sort()).toEqual([a.id, c.id].sort());
    expect(result.currencies).toEqual([
      expect.objectContaining({ currency: 'EUR', estimatedMinor: '20000', budgetMinor: '10000' }),
      expect.objectContaining({ currency: 'USD', estimatedMinor: '20000', budgetMinor: '10000' }),
    ]);
    expect(await service.portfolioBudgets(viewer, portfolio.id)).toMatchObject({
      projects: [],
      currencies: [],
      estimatedMinutes: 0,
      actualMinutes: 0,
    });
  });
  it('atomically delivers a personal threshold to Inbox and bell exactly once under concurrent workers', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id, p.id);
    await rate(p.id);
    const b = await alert(p.id);
    const results = await Promise.all([
      service.runScheduledBudgetWork(tenantId),
      service.runScheduledBudgetWork(tenantId),
    ]);
    expect(results.reduce((n, r) => n + r.executed, 0)).toBe(1);
    const bell = await service.notifications(owner),
      item = bell.items.find((i) => i.event.kind === 'budget_threshold')!;
    expect(item.deepLink).toBe(`/planner?scope=budget&project=${p.id}`);
    expect(item.event.budgetThreshold).toEqual({ projectId: p.id });
    expect(item.event.projectId).toBeNull();
    expect((await service.inbox(owner)).some((i) => i.id === item.id)).toBe(true);
    expect(
      (await service.notifications(other)).items.some((i) => i.event.kind === 'budget_threshold'),
    ).toBe(false);
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(0);
    await service.saveBudgetAlert(owner, p.id, {
      version: b.alert.version,
      data: { enabled: true, percent: 90, comparison: 'budget' },
    });
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(1);
    await service.readAllNotifications(owner);
    expect((await service.notifications(owner)).unread).toBe(0);
  });
  it('hides financial alerts from every read and mutation after project admin demotion', async () => {
    const p = await project(other, [{ userId: owner.clerkUserId, role: 'admin' }]);
    await task(p.id);
    const t = (await service.tasks(owner, { projectId: p.id })).items[0]!;
    await log(t.id, p.id);
    await rate(p.id);
    await alert(p.id);
    await service.runScheduledBudgetWork(tenantId);
    const item = (await service.notifications(owner)).items.find(
      (i) => i.event.kind === 'budget_threshold',
    )!;
    expect(item).toBeDefined();
    await service.saveProject(other, p.id, {
      version: p.version,
      data: { members: [{ userId: owner.clerkUserId, role: 'editor' }] },
    });
    expect((await service.notifications(owner)).items.some((i) => i.id === item.id)).toBe(false);
    expect((await service.inbox(owner)).some((i) => i.id === item.id)).toBe(false);
    await expect(service.updateInbox(owner, item.id, { read: true })).rejects.toMatchObject({
      status: 404,
    });
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(0);
    await service.readAllNotifications(owner);
    const persisted = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerInbox.findFirst({ where: { tenantId, id: item.id } }),
    );
    expect(persisted?.read).toBe(false);
  });
  it('waits for rates and a positive reference, skips archived projects and disabled alerts', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id, p.id);
    await service.saveProjectBudget(owner, p.id, {
      version: 0,
      data: { measurement: 'cost', budgetMinor: '10000' },
    });
    await alert(p.id);
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(0);
    await rate(p.id);
    await service.saveProject(owner, p.id, { version: p.version, archived: true });
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(0);
    await expect(
      service.saveBudgetAlert(owner, p.id, {
        version: 1,
        data: { enabled: false, percent: 80, comparison: 'budget' },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('enforces immutable receipt privileges, RLS, foreign-key scope and rollback on failed receipt insertion', async () => {
    const p = await project(),
      t = await task(p.id);
    await log(t.id, p.id);
    await rate(p.id);
    await alert(p.id);
    const before = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.count({ where: { tenantId, kind: 'budget_threshold' } }),
    );
    // Inject a transient transaction failure at receipt creation after event/inbox writes.
    const wrapper = new PlannerService(
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
              return run(
                new Proxy(tx, {
                  get(target, key) {
                    if (key === 'spPlannerBudgetAlertClaim')
                      return new Proxy(target.spPlannerBudgetAlertClaim, {
                        get(model, method) {
                          if (method === 'create')
                            return () => {
                              throw Error('transient receipt failure');
                            };
                          return Reflect.get(model, method);
                        },
                      });
                    return Reflect.get(target, key);
                  },
                }),
              );
            },
            options,
          ),
      } as PrismaService,
      { validate: async () => undefined } as unknown as PlannerLinksService,
    );
    expect((await wrapper.runScheduledBudgetWork(tenantId)).failed).toBe(1);
    expect(
      await db.withTenant(tenantId, (tx) =>
        tx.spPlannerEvent.count({ where: { tenantId, kind: 'budget_threshold' } }),
      ),
    ).toBe(before);
    expect((await service.runScheduledBudgetWork(tenantId)).executed).toBe(1);
    const receipt = await db.withTenant(tenantId, (tx) =>
      tx.spPlannerBudgetAlertClaim.findFirst({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
      }),
    );
    await expect(
      db.withTenant(tenantId, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.spPlannerBudgetAlertClaim.update({
          where: { tenantId, id: receipt!.id },
          data: { ownerId: 'tamper' },
        });
      }),
    ).rejects.toThrow();
    await expect(
      db.withTenant(tenantId, (tx) =>
        tx.spPlannerBudgetAlertClaim.delete({ where: { tenantId, id: receipt!.id } }),
      ),
    ).rejects.toThrow();
    const elsewhere = '10000000-0000-4000-8000-000000000001';
    const hidden = await db.withTenant(elsewhere, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      return tx.$queryRaw`SELECT id FROM sp_planner_budget_alert_claims WHERE id=${receipt!.id}::uuid`;
    });
    expect(hidden).toEqual([]);
    await expect(
      db.withTenant(elsewhere, async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
        await tx.spPlannerBudgetAlertClaim.create({
          data: {
            tenantId: elsewhere,
            resourceId: receipt!.resourceId,
            eventId: receipt!.eventId,
            ownerId: 'other',
            fingerprint: 'a'.repeat(64),
          },
        });
      }),
    ).rejects.toThrow();
  });
  it('advances budget alert pages so later projects are reachable after fifty candidates', async () => {
    const rows = Array.from({ length: 51 }, () => ({
        id: randomUUID(),
        projectId: randomUUID(),
      })).sort((a, b) => a.id.localeCompare(b.id)),
      last = rows[50]!;
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      await tx.spPlannerProject.createMany({
        data: rows.map((r) => ({
          id: r.projectId,
          tenantId,
          ownerId: owner.clerkUserId,
          data: JSON.parse(JSON.stringify({ ...PLANNER_DEFAULT_PROJECT, name: 'Budget page' })),
        })),
      });
      await tx.spPlannerResource.createMany({
        data: rows.map((r) => ({
          id: r.id,
          tenantId,
          projectId: r.projectId,
          ownerId: owner.clerkUserId,
          kind: 'project_budget_alert',
          name: 'Budget page alert',
          data: { enabled: true, percent: 80, comparison: 'budget' },
        })),
      });
      await tx.spPlannerResource.create({
        data: {
          tenantId,
          projectId: last.projectId,
          ownerId: owner.clerkUserId,
          kind: 'project_budget',
          name: 'Budget page',
          data: JSON.parse(JSON.stringify({ ...plannerDefaultBudget(), budgetMinutes: 60 })),
        },
      });
      await tx.spPlannerEvent.create({
        data: {
          tenantId,
          actorId: owner.clerkUserId,
          projectId: last.projectId,
          kind: 'time',
          text: 'Budget page time',
          minutes: 60,
          details: {
            time: {
              projectId: last.projectId,
              workedOn: '2026-10-07',
              timeZone: 'UTC',
              billable: false,
              category: '',
            },
          },
        },
      });
    });
    const first = await service.runScheduledBudgetWork(tenantId);
    expect(first).toMatchObject({ executed: 0, failed: 0, nextCursor: rows[49]!.id });
    expect(
      await service.runScheduledBudgetWork(tenantId, new Date(), first.nextCursor!),
    ).toMatchObject({ executed: 1, failed: 0, nextCursor: null });
  });
});
