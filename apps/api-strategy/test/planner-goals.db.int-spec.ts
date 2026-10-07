import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import type { PlannerGoalData, PlannerResource } from '@capiro/strategy-verifier';
import { randomUUID } from 'node:crypto';

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Planner DB tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const base = (patch: Partial<PlannerGoalData> = {}): PlannerGoalData => ({
  description: '',
  privacy: 'private',
  members: [],
  projectIds: [],
  ownerId: null,
  dueOn: null,
  status: 'on_track',
  progress: 'manual',
  current: 0,
  target: 100,
  unit: '%',
  ...patch,
});
describeDb('Planner goals PostgreSQL access and concurrency', () => {
  let db: PrismaService, service: PlannerService;
  const owner: AuthTenantContext = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    clerkUserId: 'user_owner',
    role: 'org:admin',
  };
  const viewer = { ...owner, clerkUserId: 'user_viewer' };
  const other = {
    ...owner,
    tenantId: '10000000-0000-4000-8000-000000000002',
    clerkUserId: 'user_foreign',
  };
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    service = new PlannerService(db, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const goal = (data: Partial<PlannerGoalData> = {}) =>
    service.saveResource(owner, null, {
      kind: 'goal',
      name: `Synthetic goal ${randomUUID()}`,
      data: base(data),
    });
  const read = async (ctx: AuthTenantContext, id: string) =>
    (await service.resources(ctx)).find((r) => r.id === id)!;

  it('calculates from persisted tasks independently of client pagination and updates after completion', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: `Goal project ${randomUUID()}` },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Rollup task',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const g = await goal({ progress: 'project_task_completion', projectIds: [p.id] });
    expect(g.goalProgress?.percentage).toBe(0);
    await service.saveTask(owner, t.id, { version: t.version, data: { status: 'done' } });
    expect((await read(owner, g.id)).goalProgress?.percentage).toBe(100);
    const child = await goal({ current: 25 });
    const parent = await goal({ progress: 'subgoal_percentage', subgoalIds: [child.id] });
    expect(parent.goalProgress?.percentage).toBe(25);
    const updated = await service.saveResource(owner, child.id, {
      version: child.version,
      data: { current: 60 },
    });
    expect(updated.parentGoalIds).toContain(parent.id);
    expect((await read(owner, parent.id)).goalProgress?.percentage).toBe(60);
  });
  it('persists decreasing zero-target metrics and propagates their interval progress', async () => {
    const child = await goal({
      startValue: 100,
      target: 0,
      current: 70,
      direction: 'decrease',
      unit: 'incidents',
    });
    expect(child.goalProgress).toMatchObject({ value: 70, percentage: 30 });
    const parent = await goal({ progress: 'subgoal_percentage', subgoalIds: [child.id] });
    await service.saveResource(owner, child.id, { version: child.version, data: { current: 20 } });
    expect((await read(owner, parent.id)).goalProgress?.percentage).toBe(80);
  });
  it('redacts private child and parent goals without granting access, preserving hidden references during edits', async () => {
    const child = await goal({ current: 50 });
    const parent = await goal({
      members: [{ userId: viewer.clerkUserId, role: 'editor' }],
      progress: 'subgoal_percentage',
      subgoalIds: [child.id],
      weightMode: 'custom',
      weights: [{ sourceId: child.id, weight: 100 }],
    });
    const hiddenParent = await goal({ subgoalIds: [parent.id] });
    const visible = await read(viewer, parent.id);
    expect(visible.data.subgoalIds).toEqual([]);
    expect(visible.data.weights).toEqual([]);
    expect(visible.parentGoalIds).toEqual([]);
    expect(visible.goalProgress).toMatchObject({ percentage: 0, sources: [] });
    expect(
      (await service.resources(viewer)).some((g) => g.id === child.id || g.id === hiddenParent.id),
    ).toBe(false);
    const renamed = await service.saveResource(viewer, parent.id, {
      version: parent.version,
      name: 'Authorized rename',
      data: { subgoalIds: [] },
    });
    expect(renamed.data.subgoalIds).toEqual([]);
    expect((await read(owner, parent.id)).data.subgoalIds).toEqual([child.id]);
    await expect(
      service.saveResource(viewer, parent.id, {
        version: renamed.version,
        data: { subgoalIds: [child.id] },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('normalizes visible custom weights while retaining hidden weights and rechecks revoked project grants', async () => {
    const hidden = await service.saveProject(owner, null, {
      data: { name: `Private source ${randomUUID()}` },
    });
    const makeProject = () =>
      service.saveProject(owner, null, {
        data: {
          name: `Shared source ${randomUUID()}`,
          members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
        },
      });
    const a = await makeProject(),
      b = await makeProject();
    const g = await goal({
      members: [{ userId: viewer.clerkUserId, role: 'editor' }],
      progress: 'project_task_completion',
      projectIds: [hidden.id, a.id, b.id],
      weightMode: 'custom',
      weights: [
        { sourceId: hidden.id, weight: 60 },
        { sourceId: a.id, weight: 20 },
        { sourceId: b.id, weight: 20 },
      ],
    });
    const visible = await read(viewer, g.id);
    expect(visible.data.projectIds).toEqual([a.id, b.id]);
    expect(visible.data.weights).toEqual([
      { sourceId: a.id, weight: 50 },
      { sourceId: b.id, weight: 50 },
    ]);
    const changed = await service.saveResource(viewer, g.id, {
      version: g.version,
      data: {
        weights: [
          { sourceId: a.id, weight: 70 },
          { sourceId: b.id, weight: 30 },
        ],
      },
    });
    expect(changed.data.weights).toEqual([
      { sourceId: a.id, weight: 70 },
      { sourceId: b.id, weight: 30 },
    ]);
    const stored = await read(owner, g.id);
    const weights = stored.data.weights as PlannerGoalData['weights'];
    expect(weights?.find((w) => w.sourceId === hidden.id)?.weight).toBeCloseTo(60);
    expect(weights?.find((w) => w.sourceId === a.id)?.weight).toBeCloseTo(28);
    expect(weights?.find((w) => w.sourceId === b.id)?.weight).toBeCloseTo(12);
    await service.saveProject(owner, a.id, { version: a.version, data: { members: [] } });
    const revoked = await read(viewer, g.id);
    expect(revoked.data.projectIds).toEqual([b.id]);
    expect(revoked.data.weights).toEqual([{ sourceId: b.id, weight: 100 }]);
    expect(revoked.goalProgress?.sources.map((s) => s.id)).toEqual([b.id]);
  });
  it('connects selected accessible tasks and removes their contributions after access revocation', async () => {
    const task = await service.saveTask(owner, null, {
      data: { name: 'Assigned contributor', assigneeId: viewer.clerkUserId, status: 'done' },
    });
    const hidden = await service.saveTask(owner, null, { data: { name: 'Hidden contributor' } });
    const g = await goal({
      members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
      progress: 'task_list_completion',
      taskIds: [task.id, hidden.id],
    });
    expect((await read(viewer, g.id)).data.taskIds).toEqual([task.id]);
    expect((await read(viewer, g.id)).goalProgress?.percentage).toBe(100);
    await service.saveTask(owner, task.id, { version: task.version, data: { assigneeId: null } });
    expect((await read(viewer, g.id)).goalProgress).toMatchObject({ percentage: 0, sources: [] });
    await expect(
      service.saveResource(viewer, g.id, { version: g.version, data: { current: 10 } }),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('serializes opposite graph edits and stale versions without allowing cycles', async () => {
    const a = await goal(),
      b = await goal();
    const changes = await Promise.allSettled([
      service.saveResource(owner, a.id, { version: a.version, data: { subgoalIds: [b.id] } }),
      service.saveResource(owner, b.id, { version: b.version, data: { subgoalIds: [a.id] } }),
    ]);
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(changes.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const rejection = changes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejection.reason).toMatchObject({ status: 400 });
    const saved = changes.find(
      (r) => r.status === 'fulfilled',
    ) as PromiseFulfilledResult<PlannerResource>;
    await expect(
      service.saveResource(owner, saved.value.id, { version: 1, name: 'Stale overwrite' }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rejects cross-tenant references, self-links and incompatible numeric totals', async () => {
    const remote = await service.saveResource(other, null, {
      kind: 'goal',
      name: 'Other tenant goal',
      data: base(),
    });
    await expect(goal({ subgoalIds: [remote.id] })).rejects.toMatchObject({ status: 404 });
    const g = await goal();
    await expect(
      service.saveResource(owner, g.id, { version: g.version, data: { subgoalIds: [g.id] } }),
    ).rejects.toMatchObject({ status: 400 });
    const dollars = await goal({ current: 200, target: 1000, unit: 'USD' });
    await expect(
      goal({ progress: 'subgoal_total', unit: 'EUR', subgoalIds: [dollars.id] }),
    ).rejects.toMatchObject({ status: 400 });
    const total = await goal({
      progress: 'subgoal_total',
      unit: 'USD',
      target: 1000,
      subgoalIds: [dollars.id],
    });
    expect(total.goalProgress).toMatchObject({ value: 200, percentage: 20 });
    await expect(
      service.saveResource(owner, dollars.id, { version: dollars.version, data: { unit: 'EUR' } }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('archives and restores goal sources without deleting their connections', async () => {
    const child = await goal({ current: 75 });
    const parent = await goal({ progress: 'subgoal_percentage', subgoalIds: [child.id] });
    const archived = await service.saveResource(owner, child.id, {
      version: child.version,
      archived: true,
    });
    expect((await read(owner, parent.id)).goalProgress?.percentage).toBe(0);
    expect((await read(owner, parent.id)).data.subgoalIds).toEqual([child.id]);
    await service.saveResource(owner, child.id, { version: archived.version, archived: false });
    expect((await read(owner, parent.id)).goalProgress?.percentage).toBe(75);
  });
});
