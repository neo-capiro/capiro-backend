import { randomUUID } from 'node:crypto';
import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import type { PlannerGoalData } from '@capiro/strategy-verifier';
const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Planner DB tests require dedicated localhost planner_qa');
}
const describeDb = testUrl ? describe : describe.skip;
const tenantId = '10000000-0000-4000-8000-000000000011';
const owner: AuthTenantContext = {
  tenantId,
  clerkUserId: 'user_goal_updates_owner',
  role: 'org:admin',
};
const viewer = { ...owner, clerkUserId: 'user_goal_updates_viewer', role: 'org:member' };
const stranger = { ...owner, clerkUserId: 'user_goal_updates_stranger', role: 'org:member' };
const base = (patch: Partial<PlannerGoalData> = {}): PlannerGoalData => ({
  description: '',
  privacy: 'private',
  members: [],
  projectIds: [],
  ownerId: owner.clerkUserId,
  dueOn: null,
  status: 'on_track',
  progress: 'manual',
  current: 0,
  target: 100,
  unit: '%',
  ...patch,
});
const post = (version: number, patch: Record<string, unknown> = {}) => ({
  version,
  status: 'on_track',
  title: 'Synthetic weekly update',
  sections: [{ id: randomUUID(), title: 'Summary', text: '**Progress** is ready.' }],
  ...patch,
});
describeDb('Planner goal activity and reminder PostgreSQL', () => {
  let db: PrismaService, service: PlannerService;
  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await db.$connect();
    service = new PlannerService(db, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
    await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO users(id,clerk_user_id,first_name,last_name,email) VALUES
        ('91000000-0000-4000-8000-000000000011'::uuid,'user_goal_updates_owner','Goal','Owner','goal-owner@example.test'),
        ('91000000-0000-4000-8000-000000000012'::uuid,'user_goal_updates_viewer','Goal','Viewer','goal-viewer@example.test'),
        ('91000000-0000-4000-8000-000000000013'::uuid,'user_goal_updates_stranger','Goal','Stranger','goal-stranger@example.test') ON CONFLICT DO NOTHING`;
      await tx.$executeRaw`INSERT INTO tenant_memberships(tenant_id,user_id,status)
        SELECT ${tenantId}::uuid,u.id,'active' FROM users u WHERE u.clerk_user_id IN ('user_goal_updates_owner','user_goal_updates_viewer','user_goal_updates_stranger')
        AND NOT EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=${tenantId}::uuid AND m.user_id=u.id)`;
    });
  });
  beforeEach(async () => {
    await db.withTenant(tenantId, async (tx) => {
      await tx.spPlannerResource.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.spPlannerInbox.updateMany({ where: { tenantId }, data: { archived: true } });
      await tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`;
    });
  });
  afterAll(async () => db?.$disconnect());
  const goal = (patch: Partial<PlannerGoalData> = {}) =>
    service.saveResource(owner, null, {
      kind: 'goal',
      name: `Synthetic activity goal ${randomUUID()}`,
      data: base(patch),
    });
  const read = async (id: string, ctx = owner) =>
    (await service.resources(ctx)).find((g) => g.id === id)!;
  it('commits owner reminder settings with a status post and rejects unauthorized or stale settings atomically', async () => {
    const g = await goal({
      members: [{ userId: viewer.clerkUserId, role: 'editor' }],
      followers: [viewer.clerkUserId],
    });
    const reminder = { cadence: 'monthly', anchorOn: '2043-01-31', time: '09:45', timeZone: 'UTC' };
    await expect(
      service.postGoalUpdate(viewer, g.id, post(g.version, { reminder, timeZone: 'UTC' })),
    ).rejects.toMatchObject({ status: 403 });
    expect((await read(g.id)).version).toBe(g.version);
    expect(
      (await service.events(owner, { resourceId: g.id })).some((e) => e.kind === 'goal_status'),
    ).toBe(false);
    const result = await service.postGoalUpdate(
      owner,
      g.id,
      post(g.version, { reminder, timeZone: 'UTC' }),
    );
    expect(result.goal.data).toMatchObject({ reminder, timeZone: 'UTC' });
    expect((await service.notifications(viewer)).unread).toBe(1);
    await expect(
      service.postGoalUpdate(owner, g.id, post(g.version, { reminder: null, current: 50 })),
    ).rejects.toMatchObject({ status: 409 });
    expect((await read(g.id)).data).toMatchObject({ reminder, current: 0 });
    expect(
      (await service.events(owner, { resourceId: g.id })).filter((e) => e.kind === 'goal_status'),
    ).toHaveLength(1);
    expect((await service.notifications(viewer)).unread).toBe(1);
  });
  it('atomically posts structured status/manual progress, preserves historical targets and propagates parent history', async () => {
    const child = await goal({
      startValue: 100,
      target: 0,
      current: 70,
      direction: 'decrease',
      unit: 'incidents',
    });
    const parent = await goal({ progress: 'subgoal_percentage', subgoalIds: [child.id] });
    const result = await service.postGoalUpdate(
      owner,
      child.id,
      post(child.version, { current: 20, status: 'at_risk' }),
    );
    expect(result.goal.goalProgress?.percentage).toBe(80);
    expect(result.event.goalSnapshot).toMatchObject({
      value: 20,
      percentage: 80,
      startValue: 100,
      target: 0,
      unit: 'incidents',
      status: 'at_risk',
    });
    expect(result.event.goalUpdate?.sections[0]?.text).toContain('**Progress**');
    expect(
      (await service.events(owner, { resourceId: parent.id }))[0]?.goalSnapshot?.percentage,
    ).toBe(80);
    const changed = await service.saveResource(owner, child.id, {
      version: result.goal.version,
      data: { target: -100 },
    });
    const history = await service.events(owner, { resourceId: child.id });
    expect(history.find((e) => e.id === result.event.id)?.goalSnapshot?.target).toBe(0);
    expect(history[0]?.goalSnapshot?.target).toBe(-100);
    await expect(
      service.postGoalUpdate(owner, child.id, post(child.version)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.reviseEvent(owner, result.event.id, { version: 0, text: 'Rewrite' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(changed.version).toBe(child.version + 2);
  });
  it('permits self-follow for existing viewers without widening grants, delivers once after concurrent posts and stops after unfollow', async () => {
    const g = await goal({ members: [{ userId: viewer.clerkUserId, role: 'viewer' }] });
    await expect(
      service.followGoal(stranger, g.id, { version: g.version, following: true }),
    ).rejects.toMatchObject({ status: 404 });
    await service.followGoal(viewer, g.id, { version: g.version, following: true });
    const current = await read(g.id);
    const results = await Promise.allSettled([
      service.postGoalUpdate(owner, g.id, post(current.version)),
      service.postGoalUpdate(owner, g.id, post(current.version)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status,
    ).toBe(409);
    const feed = await service.notifications(viewer);
    expect(feed.unread).toBe(1);
    expect(feed.items[0]?.event.resourceId).toBe(g.id);
    expect(feed.items[0]?.deepLink).toBe(`/planner?scope=goals&goal=${g.id}`);
    const page = await service.events(viewer, { resourceId: g.id }, { paged: 'true' });
    expect(Array.isArray(page)).toBe(false);
    if (!Array.isArray(page))
      expect(page.goalContext).toEqual({ audienceCount: 2, following: true });
    await service.followGoal(viewer, g.id, {
      version: (await read(g.id)).version,
      following: false,
    });
    await service.postGoalUpdate(owner, g.id, post((await read(g.id)).version));
    expect((await service.notifications(viewer)).unread).toBe(1);
  });
  it('rechecks comment permissions and goal access on corrections, Inbox, bell, marking reads and subsequent posts', async () => {
    let g = await goal({ members: [{ userId: viewer.clerkUserId, role: 'viewer' }] });
    await expect(
      service.addEvent(
        viewer,
        { resourceId: g.id },
        { kind: 'comment', text: 'Viewer cannot post' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(service.postGoalUpdate(viewer, g.id, post(g.version))).rejects.toMatchObject({
      status: 403,
    });
    g = await service.saveResource(owner, g.id, {
      version: g.version,
      data: { members: [{ userId: viewer.clerkUserId, role: 'commenter' }] },
    });
    const comment = await service.addEvent(
      viewer,
      { resourceId: g.id },
      { kind: 'comment', text: 'Comment with formatting' },
    );
    const revision = await service.reviseEvent(viewer, comment.id, {
      version: 0,
      text: 'Corrected comment',
    });
    expect(revision.version).toBe(1);
    expect((await service.inbox(owner)).find((i) => i.event.id === comment.id)?.event.text).toBe(
      'Corrected comment',
    );
    await service.followGoal(viewer, g.id, { version: g.version, following: true });
    g = await read(g.id);
    await service.postGoalUpdate(owner, g.id, post(g.version));
    const notice = (await service.notifications(viewer)).items[0]!;
    g = await read(g.id);
    await service.saveResource(owner, g.id, { version: g.version, data: { members: [] } });
    expect((await service.notifications(viewer)).unread).toBe(0);
    expect((await service.inbox(viewer)).some((i) => i.event.resourceId === g.id)).toBe(false);
    expect(await service.readAllNotifications(viewer)).toEqual({ read: 0 });
    await expect(service.updateInbox(viewer, notice.id, { read: true })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.reviseEvent(viewer, comment.id, { version: 1, text: 'After revoke' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.events(viewer, { resourceId: g.id })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('redacts historical numeric snapshots after transitive source access is revoked and restores the original values after regrant', async () => {
    let child = await goal({
      current: 73,
      members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
    });
    const parent = await goal({
      progress: 'subgoal_percentage',
      subgoalIds: [child.id],
      members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
    });
    await service.followGoal(viewer, parent.id, { version: parent.version, following: true });
    const root = await goal({
      progress: 'subgoal_percentage',
      subgoalIds: [parent.id],
      members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
    });
    const update = await service.postGoalUpdate(owner, root.id, post(root.version));
    expect(
      (await service.events(viewer, { resourceId: root.id })).find((e) => e.id === update.event.id)
        ?.goalSnapshot?.percentage,
    ).toBe(73);
    child = await service.saveResource(owner, child.id, {
      version: child.version,
      data: { members: [], current: 18 },
    });
    const hidden = (await service.events(viewer, { resourceId: root.id })).find(
      (e) => e.id === update.event.id,
    )!;
    expect(hidden.goalSnapshot?.percentage).toBeUndefined();
    expect(hidden.goalSnapshot?.value).toBeUndefined();
    expect(JSON.stringify(hidden)).not.toContain(child.id);
    expect(hidden.goalUpdate?.title).toBe('Synthetic weekly update');
    await service.saveResource(owner, child.id, {
      version: child.version,
      data: { members: [{ userId: viewer.clerkUserId, role: 'viewer' }] },
    });
    expect(
      (await service.events(viewer, { resourceId: root.id })).find((e) => e.id === update.event.id)
        ?.goalSnapshot?.percentage,
    ).toBe(73);
  });
  it('records connected task/project history automatically and hides selected-task snapshots after its grant is revoked', async () => {
    let p = await service.saveProject(owner, null, {
      data: {
        name: 'Historical task source',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Historical task',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const selected = await goal({
      progress: 'task_list_completion',
      taskIds: [t.id],
      members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
    });
    const linked = await goal({ progress: 'project_task_completion', projectIds: [p.id] });
    await service.saveTask(owner, t.id, { version: t.version, data: { status: 'done' } });
    expect(
      (await service.events(owner, { resourceId: selected.id })).map(
        (e) => e.goalSnapshot?.percentage,
      ),
    ).toEqual([100, 0]);
    expect(
      (await service.events(owner, { resourceId: linked.id }))[0]?.goalSnapshot?.percentage,
    ).toBe(100);
    p = await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    expect(
      (await service.events(viewer, { resourceId: selected.id })).every(
        (e) => e.goalSnapshot?.percentage === undefined,
      ),
    ).toBe(true);
    await service.saveProject(owner, p.id, { version: p.version, archived: true });
    expect(
      (await service.events(owner, { resourceId: linked.id }))[0]?.goalSnapshot?.percentage,
    ).toBe(0);
  });
  it('limits reminder settings to the responsible owner and validates follower grants and active identities', async () => {
    const g = await goal({ members: [{ userId: viewer.clerkUserId, role: 'editor' }] });
    const reminder = { cadence: 'weekly', anchorOn: '2043-01-01', time: '09:00', timeZone: 'UTC' };
    await expect(
      service.saveResource(viewer, g.id, { version: g.version, data: { reminder } }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.saveResource(owner, g.id, {
        version: g.version,
        data: { followers: [stranger.clerkUserId] },
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.saveResource(viewer, g.id, {
        version: g.version,
        data: { followers: [viewer.clerkUserId] },
      }),
    ).rejects.toMatchObject({ status: 403 });
    const configured = await service.saveResource(owner, g.id, {
      version: g.version,
      data: { reminder },
    });
    const transferred = await service.saveResource(owner, g.id, {
      version: configured.version,
      data: { ownerId: viewer.clerkUserId },
    });
    expect(transferred.data.reminder).toBeNull();
    // Responsible ownership is metadata and never silently expands private grants.
    const privateGoal = await goal({ ownerId: stranger.clerkUserId });
    expect(await read(privateGoal.id, stranger)).toBeUndefined();
    expect(
      (await service.runScheduledGoalWork(tenantId, new Date('2043-01-01T09:00:00Z'))).executed,
    ).toBe(0);
  });
  it('records intake changes under current form-owner grants without exposing goals in anonymous receipts', async () => {
    const p = await service.saveProject(owner, null, { data: { name: 'Goal intake source' } });
    const task = await service.saveTask(owner, null, {
      data: {
        name: 'Completed initial task',
        status: 'done',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const g = await goal({ progress: 'project_task_completion', projectIds: [p.id] });
    const fieldId = randomUUID();
    const form = await service.saveResource(owner, null, {
      kind: 'form',
      projectId: p.id,
      name: 'Goal history intake',
      data: {
        description: '',
        enabled: true,
        audience: 'public',
        fields: [
          {
            id: fieldId,
            label: 'Task name',
            type: 'text',
            required: true,
            taskField: 'name',
            options: [],
          },
        ],
        defaults: { assigneeId: null, priority: 'none' },
      },
    });
    const share = await service.shareForm(owner, form.id, { version: form.version, enabled: true });
    const result = await service.submitPublicForm(share.token!, { [fieldId]: 'Anonymous task' });
    expect(result).toEqual({ received: true });
    const history = await service.events(owner, { resourceId: g.id });
    expect(history[0]?.goalSnapshot?.percentage).toBe(50);
    expect(history[0]?.actorId).toBe(`public_form:${form.id}`);
    expect(history[0]?.text).not.toContain('Anonymous task');
    expect(task.id).toBeTruthy();
  });
  it('filters revoked goal rows before the bell limit and authorized unread count', async () => {
    const visible = await goal({ members: [{ userId: viewer.clerkUserId, role: 'viewer' }] });
    const hidden = await goal();
    await db.withTenant(tenantId, async (tx) => {
      for (const g of [visible, hidden]) {
        const ids = Array.from({ length: 105 }, () => randomUUID());
        await tx.spPlannerEvent.createMany({
          data: ids.map((id) => ({
            id,
            tenantId,
            resourceId: g.id,
            actorId: owner.clerkUserId,
            kind: 'comment',
            text: g.id === hidden.id ? 'Private text' : 'Visible text',
          })),
        });
        await tx.spPlannerInbox.createMany({
          data: ids.map((eventId) => ({ tenantId, userId: viewer.clerkUserId, eventId })),
        });
      }
    });
    const feed = await service.notifications(viewer);
    expect(feed.unread).toBe(105);
    expect(feed.items).toHaveLength(100);
    expect(feed.items.every((i) => i.event.resourceId === visible.id)).toBe(true);
    expect(JSON.stringify(feed)).not.toContain('Private text');
    expect(await service.readAllNotifications(viewer)).toEqual({ read: 105 });
    expect((await service.notifications(viewer)).unread).toBe(0);
  });
  it('rolls back event, Inbox and receipt together after a delivery failure and succeeds once on retry', async () => {
    const g = await goal({
      reminder: { cadence: 'weekly', anchorOn: '2043-01-01', time: '09:00', timeZone: 'UTC' },
    });
    const faultDb = {
      withTenant: (tenant: string, run: (tx: unknown) => Promise<unknown>, options: unknown) =>
        db.withTenant(
          tenant,
          (tx) =>
            run(
              new Proxy(tx, {
                get(target, property) {
                  if (property === 'spPlannerGoalReminderClaim')
                    return {
                      ...target.spPlannerGoalReminderClaim,
                      create: async () => {
                        throw new Error('Synthetic receipt failure');
                      },
                    };
                  return Reflect.get(target, property);
                },
              }),
            ),
          options as never,
        ),
    } as unknown as PrismaService;
    const failing = new PlannerService(faultDb, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
    const now = new Date('2043-01-01T10:00:00Z');
    expect((await failing.runScheduledGoalWork(tenantId, now)).failed).toBe(1);
    expect((await service.notifications(owner)).unread).toBe(0);
    expect(
      (await service.events(owner, { resourceId: g.id })).some((e) => e.kind === 'reminder'),
    ).toBe(false);
    expect((await service.runScheduledGoalWork(tenantId, now)).executed).toBe(1);
    expect((await service.runScheduledGoalWork(tenantId, now)).executed).toBe(0);
  });
  it('deduplicates cadence and grading notices across concurrent cycles, unrelated edits and restarts', async () => {
    const g = await goal({
      dueOn: '2043-01-08',
      timeZone: 'UTC',
      reminder: { cadence: 'weekly', anchorOn: '2043-01-01', time: '09:00', timeZone: 'UTC' },
    });
    expect(
      (await service.runScheduledGoalWork(tenantId, new Date('2043-01-01T08:59:59Z'))).executed,
    ).toBe(0);
    const now = new Date('2043-01-01T09:00:00Z');
    const results = await Promise.all([
      service.runScheduledGoalWork(tenantId, now),
      service.runScheduledGoalWork(tenantId, now),
    ]);
    expect(results.reduce((n, r) => n + r.executed, 0)).toBe(2);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    expect((await service.notifications(owner)).unread).toBe(2);
    const renamed = await service.saveResource(owner, g.id, {
      version: g.version,
      name: 'Unrelated rename',
    });
    const restarted = new PlannerService(db, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
    expect((await restarted.runScheduledGoalWork(tenantId, now)).executed).toBe(0);
    expect(
      (await restarted.runScheduledGoalWork(tenantId, new Date('2043-01-22T10:00:00Z'))).executed,
    ).toBe(1);
    expect((await service.notifications(owner)).unread).toBe(3);
    await service.saveResource(owner, g.id, {
      version: renamed.version,
      data: { status: 'achieved' },
    });
    expect(
      (await restarted.runScheduledGoalWork(tenantId, new Date('2043-01-29T10:00:00Z'))).executed,
    ).toBe(0);
  });
  it('skips inactive owners and revoked owner edit access, then delivers when the owner is active and authorized', async () => {
    let g = await goal({
      ownerId: viewer.clerkUserId,
      members: [{ userId: viewer.clerkUserId, role: 'editor' }],
    });
    g = await service.saveResource(viewer, g.id, {
      version: g.version,
      data: {
        reminder: { cadence: 'weekly', anchorOn: '2043-01-01', time: '09:00', timeZone: 'UTC' },
      },
    });
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='inactive' WHERE tenant_id=${tenantId}::uuid AND user_id='91000000-0000-4000-8000-000000000012'::uuid`,
    );
    const now = new Date('2043-01-01T10:00:00Z');
    expect((await service.runScheduledGoalWork(tenantId, now)).executed).toBe(0);
    await db.withTenant(
      tenantId,
      (tx) =>
        tx.$executeRaw`UPDATE tenant_memberships SET status='active' WHERE tenant_id=${tenantId}::uuid`,
    );
    g = await service.saveResource(owner, g.id, {
      version: g.version,
      data: { members: [{ userId: viewer.clerkUserId, role: 'viewer' }] },
    });
    expect((await service.runScheduledGoalWork(tenantId, now)).executed).toBe(0);
    await service.saveResource(owner, g.id, {
      version: g.version,
      data: { members: [{ userId: viewer.clerkUserId, role: 'editor' }] },
    });
    expect((await service.runScheduledGoalWork(tenantId, now)).executed).toBe(1);
    expect((await service.notifications(viewer)).unread).toBe(1);
    expect((await service.notifications(owner)).unread).toBe(0);
  });
  it('keeps delivery receipts immutable, tenant-bound and restricted to SELECT/INSERT at runtime', async () => {
    const g = await goal({
      reminder: { cadence: 'weekly', anchorOn: '2043-01-01', time: '09:00', timeZone: 'UTC' },
    });
    await service.runScheduledGoalWork(tenantId, new Date('2043-01-01T10:00:00Z'));
    const claim = await db.withTenant(tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const claims = await tx.spPlannerGoalReminderClaim.findMany({
        where: { tenantId, resourceId: g.id },
      });
      expect(claims).toHaveLength(1);
      const rights = await tx.$queryRaw<
        { insert: boolean; update: boolean; delete: boolean }[]
      >`SELECT
        has_table_privilege(current_user,'sp_planner_goal_reminder_claims','INSERT') AS insert,
        has_table_privilege(current_user,'sp_planner_goal_reminder_claims','UPDATE') AS update,
        has_table_privilege(current_user,'sp_planner_goal_reminder_claims','DELETE') AS delete`;
      expect(rights[0]).toEqual({ insert: true, update: false, delete: false });
      return claims[0]!;
    });
    await expect(
      db.withTenant(
        tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE sp_planner_goal_reminder_claims SET kind='grading' WHERE id=${claim.id}::uuid`,
      ),
    ).rejects.toThrow();
    const foreign = '10000000-0000-4000-8000-000000000002';
    const otherGoal = await goal();
    await expect(
      db.withTenant(tenantId, (tx) =>
        tx.spPlannerGoalReminderClaim.create({
          data: {
            tenantId,
            resourceId: otherGoal.id,
            ownerId: owner.clerkUserId,
            kind: 'update',
            fingerprint: 'a'.repeat(64),
            deadlineKey: 'b'.repeat(64),
            eventId: claim.eventId,
          },
        }),
      ),
    ).rejects.toThrow();
    await db.withTenant(foreign, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      expect(await tx.spPlannerGoalReminderClaim.findMany({ where: { tenantId } })).toEqual([]);
    });
    await expect(
      db.withTenant(foreign, (tx) =>
        tx.spPlannerGoalReminderClaim.create({
          data: {
            tenantId: foreign,
            resourceId: g.id,
            ownerId: owner.clerkUserId,
            kind: 'update',
            fingerprint: 'a'.repeat(64),
            deadlineKey: 'b'.repeat(64),
            eventId: claim.eventId,
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('paginates goal history through opaque scoped cursors without accepting another goal cursor', async () => {
    const g = await goal(),
      other = await goal();
    await db.withTenant(tenantId, (tx) =>
      tx.spPlannerEvent.createMany({
        data: Array.from({ length: 103 }, (_, n) => ({
          tenantId,
          resourceId: g.id,
          actorId: owner.clerkUserId,
          kind: 'comment',
          text: `Synthetic historical comment ${n}`,
        })),
      }),
    );
    const first = await service.events(owner, { resourceId: g.id }, { paged: 'true' });
    if (Array.isArray(first)) throw new Error('Expected page');
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const second = await service.events(
      owner,
      { resourceId: g.id },
      { paged: 'true', cursor: first.nextCursor! },
    );
    if (Array.isArray(second)) throw new Error('Expected page');
    expect(second.items).toHaveLength(4);
    expect(new Set([...first.items, ...second.items].map((e) => e.id)).size).toBe(104);
    await expect(
      service.events(owner, { resourceId: other.id }, { paged: 'true', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
