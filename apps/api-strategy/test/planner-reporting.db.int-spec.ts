import { randomUUID } from 'node:crypto';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../generated/prisma-client/index.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import {
  PLANNER_DEFAULT_TASK,
  PLANNER_DEFAULT_REPORT_CHART,
  type PlannerReportChart,
  type PlannerReportWidget,
  type PlannerResource,
} from '@capiro/strategy-verifier';

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Reporting DB tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000020';
const owner: AuthTenantContext = { tenantId, clerkUserId: 'user_report_owner', role: 'org:admin' };
const viewer = { ...owner, clerkUserId: 'user_report_viewer', role: 'org:member' };
const stranger = { ...viewer, clerkUserId: 'user_report_stranger' };
const chart = (patch: Partial<PlannerReportChart> = {}): PlannerReportChart => ({
  ...structuredClone(PLANNER_DEFAULT_REPORT_CHART),
  ...patch,
});
const widget = (config = chart()): PlannerReportWidget => ({
  id: randomUUID(),
  kind: 'chart',
  title: 'Synthetic chart',
  style: 'bar',
  labels: true,
  chart: config,
});

describeDb('Planner saved reporting PostgreSQL and restricted runtime role', () => {
  let db: PrismaService, service: PlannerService;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    // The disposable fixture supplies only these canonical read tables.
    await db.$executeRawUnsafe('GRANT SELECT ON users, tenant_memberships TO capiro_app');
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,last_name,email) VALUES
        ('92000000-0000-4000-8000-000000000001'::uuid,'user_report_owner','Report','Owner','report-owner@example.test'),
        ('92000000-0000-4000-8000-000000000002'::uuid,'user_report_viewer','Report','Viewer','report-viewer@example.test'),
        ('92000000-0000-4000-8000-000000000003'::uuid,'user_report_stranger','Report','Stranger','report-stranger@example.test') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status)
        SELECT ${tenantId}::uuid,u.id,'active' FROM users u WHERE u.clerk_user_id IN ('user_report_owner','user_report_viewer','user_report_stranger')
        AND NOT EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=${tenantId}::uuid AND m.user_id=u.id)`;
    });
    // Every service operation executes as the restricted role with forced Planner RLS.
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
    await db.withTenant(tenantId, async (tx) => {
      await tx.spPlannerResource.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.spPlannerTask.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.spPlannerProject.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
    });
  });
  afterAll(async () => db?.$disconnect());
  const project = (shared = true, fields: unknown[] = []) =>
    service.saveProject(owner, null, {
      data: {
        name: `Synthetic report project ${randomUUID()}`,
        privacy: 'private',
        fields,
        members: shared ? [{ userId: viewer.clerkUserId, role: 'viewer' }] : [],
      },
    });
  const dashboard = (widgets = [widget()], projectId: string | null = null) =>
    service.saveResource(owner, null, {
      kind: 'dashboard',
      projectId,
      name: 'Synthetic saved dashboard',
      data: {
        description: '',
        privacy: 'private',
        members: [{ userId: viewer.clerkUserId, role: 'editor' }],
        widgets,
      },
    });
  const report = (
    d: PlannerResource,
    w: PlannerReportWidget,
    ctx = owner,
    query: Record<string, string> = {},
  ) => service.reportWidget(ctx, d.id, w.id, query);
  const task = (projectIds: string[], patch: Record<string, unknown> = {}) =>
    service.saveTask(owner, null, {
      data: {
        name: 'Synthetic report task',
        memberships: projectIds.map((id) => ({ projectId: id, sectionId: null, position: 0 })),
        ...patch,
      },
    });
  it('aggregates all 127 records before paging and drills into categories using stable cursors and dashboard versions', async () => {
    const p = await project();
    await db.withTenant(tenantId, (tx) =>
      tx.spPlannerTask.createMany({
        data: Array.from({ length: 127 }, (_, i) => ({
          id: randomUUID(),
          tenantId,
          ownerId: owner.clerkUserId,
          projectIds: [p.id],
          data: {
            ...PLANNER_DEFAULT_TASK,
            name: `Synthetic record ${i}`,
            estimateMinutes: 15,
            status: i < 105 ? 'todo' : 'done',
            memberships: [{ projectId: p.id, sectionId: null, position: i }],
          },
        })),
      }),
    );
    const w = widget(chart({ metric: 'estimated_minutes' })),
      d = await dashboard([w]);
    const first = await report(d, w, viewer, { rows: 'true', version: String(d.version) });
    expect(first).toMatchObject({ total: 1905, matched: 127, unavailableFields: false });
    expect(first.items).toHaveLength(100);
    const second = await report(d, w, viewer, {
      rows: 'true',
      cursor: first.nextCursor!,
      revision: first.revision,
    });
    expect(second.items).toHaveLength(27);
    expect(new Set([...first.items!, ...second.items!].map((r) => r.id)).size).toBe(127);
    expect(second.nextCursor).toBeNull();
    expect((await report(d, w, viewer, { rows: 'true', bucket: 'done' })).items).toHaveLength(22);
    await db.withTenant(tenantId, (tx) =>
      tx.spPlannerTask.update({
        where: { id: first.items![0]!.id, tenantId },
        data: { archived: true },
      }),
    );
    await expect(
      report(d, w, viewer, { rows: 'true', cursor: first.nextCursor!, revision: first.revision }),
    ).rejects.toMatchObject({ status: 409 });
    await service.saveResource(owner, d.id, { version: d.version, name: 'Changed dashboard' });
    await expect(report(d, w, viewer, { version: String(d.version) })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('uses corrected time, removes deleted time and counts shared task minutes once across project reports', async () => {
    const p = await project(),
      q = await project();
    const t = await task([p.id, q.id]);
    const event = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Synthetic time', minutes: 20 },
    );
    const w = widget(chart({ entity: 'projects', metric: 'actual_minutes', group: 'status' })),
      d = await dashboard([w]);
    expect((await report(d, w, viewer)).total).toBe(20);
    await service.reviseEvent(owner, event.id, { version: 0, minutes: 45 });
    expect(await report(d, w, viewer)).toMatchObject({ total: 45, matched: 2, overlapping: true });
    await service.reviseEvent(owner, event.id, { version: 1, removed: true });
    expect((await report(d, w, viewer)).total).toBe(0);
  });
  it('retains restricted sources through visible edits and never replaces lost access with all work', async () => {
    const p = await project(),
      q = await project();
    await task([p.id]);
    await task([q.id]);
    const c = chart();
    c.filters.source = { kind: 'projects', ids: [p.id] };
    const w = widget(c),
      d = await dashboard([w]);
    expect((await report(d, w, viewer)).total).toBe(1);
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    const view = (await service.resources(viewer)).find((r) => r.id === d.id)!;
    expect(JSON.stringify(view)).not.toContain(p.id);
    expect(view.reportWarnings?.[0]?.unavailableSources).toBe(true);
    const edited = await service.saveResource(viewer, d.id, {
      version: view.version,
      data: {
        widgets: (view.data.widgets as PlannerReportWidget[]).map((r) => ({
          ...r,
          title: 'Visible title edit',
        })),
      },
    });
    expect(await report(edited, w, viewer, { rows: 'true' })).toMatchObject({
      total: 0,
      matched: 0,
      items: [],
      unavailableSources: true,
    });
    expect((await report(edited, w, owner)).total).toBe(1);
  });
  it('redacts inaccessible field criteria and returns unavailable values rather than zero or broadening filters', async () => {
    const id = randomUUID(),
      p = await project(true, [{ id, name: 'Budget', type: 'number', options: [] }]);
    const q = await project();
    await task([p.id, q.id], { customValues: { [id]: 42 }, assigneeId: viewer.clerkUserId });
    const c = chart({ metric: 'custom_number', metricFieldId: id });
    c.filters.custom = [{ fieldId: id, values: [42] }];
    const w = widget(c),
      d = await dashboard([w]);
    expect((await report(d, w, viewer)).total).toBe(42);
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    const view = (await service.resources(viewer)).find((r) => r.id === d.id)!;
    expect(JSON.stringify(view)).not.toContain(id);
    expect(
      (view.data.widgets as Extract<PlannerReportWidget, { kind: 'chart' }>[])[0]!.chart.filters
        .custom,
    ).toEqual([]);
    const edited = await service.saveResource(viewer, d.id, {
      version: view.version,
      data: { widgets: view.data.widgets },
    });
    expect(await report(edited, w, viewer, { rows: 'true' })).toMatchObject({
      total: null,
      matched: null,
      unavailableFields: true,
      items: [],
    });
    expect((await report(edited, w, owner)).total).toBe(42);
    const textField = randomUUID();
    const textProject = await project(true, [
      { id: textField, name: 'Notes', type: 'text', options: [] },
    ]);
    await expect(
      dashboard([widget(chart({ metric: 'custom_number', metricFieldId: textField }))]),
    ).rejects.toMatchObject({ status: 400 });
    expect(textProject.id).toBeTruthy();
  });
  it('shares dashboards without exposing private projects or widening underlying task grants', async () => {
    const p = await project(false),
      q = await project();
    await task([p.id]);
    await task([q.id]);
    await task([], { assigneeId: viewer.clerkUserId });
    const w = widget(),
      d = await dashboard([w]);
    const ownerReport = await report(d, w, owner, { rows: 'true' });
    const viewerReport = await report(d, w, viewer, { rows: 'true' });
    expect(ownerReport.total).toBe(3);
    expect(viewerReport.total).toBe(2);
    await expect(report(d, w, stranger)).rejects.toMatchObject({ status: 404 });
    await expect(
      report(d, w, { ...owner, tenantId: '10000000-0000-4000-8000-000000000002' }),
    ).rejects.toMatchObject({ status: 404 });
    await service.saveResource(owner, d.id, { version: d.version, data: { members: [] } });
    await expect(report(d, w, viewer)).rejects.toMatchObject({ status: 404 });
  });
  it('keeps project dashboard charts inside their project and rejects non-task chart entities', async () => {
    const p = await project(),
      q = await project();
    await task([p.id]);
    await task([q.id]);
    const w = widget(),
      d = await dashboard([w], p.id);
    expect((await report(d, w, viewer)).total).toBe(1);
    await expect(
      dashboard([widget(chart({ entity: 'goals', metric: 'progress' }))], p.id),
    ).rejects.toMatchObject({ status: 400 });
    await expect(report(d, w, viewer, { cursor: randomUUID() })).rejects.toMatchObject({
      status: 400,
    });
    await expect(report(d, w, viewer, { unknown: 'true' })).rejects.toMatchObject({ status: 400 });
  });
  it('reports portfolio selections and persisted directional goal progress with inclusive local calendar dates', async () => {
    const p = await project();
    await task([p.id], { dueOn: '2044-01-02' });
    await task([p.id], { dueOn: '2044-01-03' });
    const portfolio = await service.saveResource(owner, null, {
      kind: 'portfolio',
      name: 'Synthetic portfolio',
      data: {
        description: '',
        privacy: 'private',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
        projectIds: [p.id],
      },
    });
    await service.saveResource(owner, null, {
      kind: 'goal',
      name: 'Synthetic decreasing goal',
      data: {
        description: '',
        privacy: 'private',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
        projectIds: [p.id],
        ownerId: owner.clerkUserId,
        dueOn: null,
        status: 'on_track',
        progress: 'manual',
        startValue: 100,
        current: 20,
        target: 0,
        direction: 'decrease',
        unit: 'incidents',
      },
    });
    const c = chart();
    c.filters.source = { kind: 'portfolios', ids: [portfolio.id] };
    c.filters.from = '2044-01-02';
    c.filters.through = '2044-01-02';
    c.filters.timeZone = 'America/New_York';
    const w = widget(c),
      g = widget(chart({ entity: 'goals', metric: 'progress', group: 'type' }));
    const ps = widget(chart({ entity: 'portfolios', metric: 'project_count', group: 'owner' }));
    const d = await dashboard([w, g, ps]);
    expect((await report(d, w, viewer)).total).toBe(1);
    expect((await report(d, g, viewer)).total).toBe(80);
    expect((await report(d, ps, viewer)).total).toBe(1);
  });
});
