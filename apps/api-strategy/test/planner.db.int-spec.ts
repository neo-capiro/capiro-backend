import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import { PLANNER_DEFAULT_TASK, PLANNER_DEFAULT_PROJECT } from '@capiro/strategy-verifier';
import { Prisma } from '../generated/prisma-client/index.js';
import { randomUUID } from 'node:crypto';

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Planner DB tests require the dedicated localhost planner_qa database');
}
const describeDb = testUrl ? describe : describe.skip;
describeDb('Planner real PostgreSQL integration', () => {
  let prisma: PrismaService;
  let service: PlannerService;
  const owner: AuthTenantContext = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    clerkUserId: 'user_owner',
    role: 'org:admin',
  };
  const viewer = { ...owner, clerkUserId: 'user_viewer' };
  const outsider = { ...owner, clerkUserId: 'user_outsider' };
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await prisma.$connect();
    service = new PlannerService(prisma, {
      validate: async () => undefined,
    } as unknown as PlannerLinksService);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  it('corrects, removes and restores time without changing the original audit record or losing totals', async () => {
    const t = await service.saveTask(owner, null, { data: { name: 'Correctable time' } });
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'time', text: 'Original note', minutes: 15 },
    );
    const corrected = await service.reviseEvent(owner, e.id, {
      version: 0,
      text: 'Corrected note',
      minutes: 30,
    });
    expect(corrected).toMatchObject({
      version: 1,
      text: 'Corrected note',
      minutes: 30,
      removed: false,
    });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(30);
    expect(
      (await service.tasks(owner, { search: 'Correctable time' })).items.find((x) => x.id === t.id)
        ?.actualMinutes,
    ).toBe(30);
    const removed = await service.reviseEvent(owner, e.id, { version: 1, removed: true });
    expect(removed).toMatchObject({ version: 2, text: '', minutes: null, removed: true });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(0);
    expect(
      (await service.events(owner, { taskId: t.id })).find((x) => x.id === e.id),
    ).toMatchObject({ text: '', removed: true });
    const restored = await service.reviseEvent(owner, e.id, { version: 2, removed: false });
    expect(restored).toMatchObject({
      version: 3,
      text: 'Corrected note',
      minutes: 30,
      removed: false,
    });
    expect((await service.task(owner, t.id)).actualMinutes).toBe(30);
    const original = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerEvent.findFirst({ where: { tenantId: owner.tenantId, id: e.id } }),
    );
    expect(original).toMatchObject({ text: 'Original note', minutes: 15 });
    const revisions = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerEventRevision.findMany({
        where: { tenantId: owner.tenantId, eventId: e.id },
        orderBy: { version: 'asc' },
      }),
    );
    expect(revisions.map((r) => r.version)).toEqual([1, 2, 3]);
    await expect(
      service.reviseEvent(owner, e.id, { version: 1, minutes: 60 }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('projects comment corrections into inbox and rechecks author and current project access', async () => {
    // Only the dedicated local synthetic inbox is cleared between repeated runs.
    await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerInbox.updateMany({
        where: { tenantId: owner.tenantId, userId: viewer.clerkUserId },
        data: { archived: true },
      }),
    );
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Comment correction grants',
        members: [{ userId: viewer.clerkUserId, role: 'commenter' }],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Inbox correction',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
        collaborators: [viewer.clerkUserId],
      },
    });
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'comment', text: 'Original comment' },
    );
    await expect(
      service.reviseEvent(viewer, e.id, { version: 0, text: 'Cannot edit another author' }),
    ).rejects.toMatchObject({ status: 404 });
    await service.reviseEvent(owner, e.id, { version: 0, text: 'Corrected comment' });
    let inbox = await service.inbox(viewer, { paged: 'true', archived: 'false' });
    expect('items' in inbox ? inbox.items.find((i) => i.event.id === e.id)?.event.text : null).toBe(
      'Corrected comment',
    );
    await service.reviseEvent(owner, e.id, { version: 1, removed: true });
    inbox = await service.inbox(viewer, { paged: 'true', archived: 'false' });
    expect(
      'items' in inbox ? inbox.items.find((i) => i.event.id === e.id)?.event : null,
    ).toMatchObject({ text: '', removed: true });
    const own = await service.addEvent(
      viewer,
      { projectId: p.id },
      { kind: 'comment', text: 'Own project comment' },
    );
    await service.reviseEvent(viewer, own.id, {
      version: 0,
      text: 'Own corrected project comment',
    });
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await service.saveTask(owner, t.id, { version: t.version, data: { collaborators: [] } });
    await expect(
      service.reviseEvent(viewer, own.id, { version: 1, text: 'Revoked access' }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('serializes activity corrections, rejects generated audit editing and keeps revisions tenant-bound and immutable', async () => {
    const t = await service.saveTask(owner, null, { data: { name: 'Revision concurrency' } });
    const e = await service.addEvent(owner, { taskId: t.id }, { kind: 'comment', text: 'Base' });
    const changes = await Promise.allSettled(
      ['A', 'B'].map((text) => service.reviseEvent(owner, e.id, { version: 0, text })),
    );
    expect(changes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(changes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const generated = (await service.events(owner, { taskId: t.id })).find(
      (x) => x.kind === 'created',
    )!;
    await expect(
      service.reviseEvent(owner, generated.id, { version: 0, text: 'Replace audit' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.reviseEvent(owner, e.id, { version: 1, minutes: 2 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.reviseEvent({ ...owner, tenantId: '10000000-0000-4000-8000-000000000002' }, e.id, {
        version: 1,
        text: 'Cross tenant',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      prisma.withTenant(
        owner.tenantId,
        (tx) =>
          tx.$executeRaw`UPDATE sp_planner_event_revisions SET text = 'Overwrite' WHERE event_id = ${e.id}::uuid`,
      ),
    ).rejects.toThrow('append-only');
    await prisma.withTenant(owner.tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const rights = await tx.$queryRaw<
        { can_insert: boolean; can_update: boolean; can_delete: boolean }[]
      >`SELECT has_table_privilege(current_user, 'sp_planner_event_revisions', 'INSERT') AS can_insert, has_table_privilege(current_user, 'sp_planner_event_revisions', 'UPDATE') AS can_update, has_table_privilege(current_user, 'sp_planner_event_revisions', 'DELETE') AS can_delete`;
      expect(rights[0]).toEqual({ can_insert: true, can_update: false, can_delete: false });
    });
    await prisma.withTenant('10000000-0000-4000-8000-000000000002', async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const hidden = await tx.$queryRaw<
        unknown[]
      >`SELECT * FROM sp_planner_event_revisions WHERE event_id = ${e.id}::uuid`;
      expect(hidden).toHaveLength(0);
    });
  });
  it('orders the Dashboard queue by deadlines across time zones', async () => {
    // This suite is restricted to localhost planner_qa. Clear earlier synthetic
    // assignments so repeated runs can assert the service's five-row ordering.
    await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerTask.updateMany({
        where: { tenantId: owner.tenantId, assigneeId: outsider.clerkUserId, archived: false },
        data: { archived: true },
      }),
    );
    const late = await service.saveTask(outsider, null, {
      data: {
        name: 'New York evening',
        assigneeId: outsider.clerkUserId,
        dueOn: '2000-01-02',
        dueTime: '20:00',
        timeZone: 'America/New_York',
      },
    });
    const early = await service.saveTask(outsider, null, {
      data: {
        name: 'Tokyo morning',
        assigneeId: outsider.clerkUserId,
        dueOn: '2000-01-03',
        dueTime: '09:00',
        timeZone: 'Asia/Tokyo',
      },
    });
    const endOfDay = await service.saveTask(outsider, null, {
      data: {
        name: 'Date only New York',
        assigneeId: outsider.clerkUserId,
        dueOn: '2000-01-02',
        timeZone: 'America/New_York',
      },
    });
    const queue = await service.queue(outsider);
    expect(queue.slice(0, 3).map((t) => t.id)).toEqual([early.id, late.id, endOfDay.id]);
    for (const t of [late, early, endOfDay])
      await service.saveTask(outsider, t.id, { version: t.version, archived: true });
    const fold = await service.saveTask(outsider, null, {
      data: {
        name: 'First folded hour',
        assigneeId: outsider.clerkUserId,
        dueOn: '2000-10-29',
        dueTime: '01:30',
        timeZone: 'America/New_York',
      },
    });
    const after = await service.saveTask(outsider, null, {
      data: {
        name: 'After first folded hour',
        assigneeId: outsider.clerkUserId,
        dueOn: '2000-10-29',
        dueTime: '06:00',
        timeZone: 'UTC',
      },
    });
    expect((await service.queue(outsider)).slice(0, 2).map((t) => t.id)).toEqual([
      fold.id,
      after.id,
    ]);
    expect(await service.task(outsider, fold.id)).not.toHaveProperty('deadlineAt');
    for (const t of [fold, after])
      await service.saveTask(outsider, t.id, { version: t.version, archived: true });
  });
  it('copies a recurring hierarchy and immutable attachments with independent identities and no prior comments or time', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: `Recurring contents ${randomUUID()}` },
    });
    const root = await service.saveTask(owner, null, {
      data: {
        name: 'Recurring parent',
        dueOn: '2026-10-06',
        recurrence: { frequency: 'weekly', interval: 1 },
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const child = await service.saveTask(owner, null, {
      data: { name: 'Recurring child', parentId: root.id, dueOn: '2026-10-05' },
    });
    const grandchild = await service.saveTask(owner, null, {
      data: { name: 'Recurring grandchild', parentId: child.id, dependencies: [root.id] },
    });
    await service.saveTask(owner, child.id, { version: child.version, data: { status: 'done' } });
    await service.addEvent(
      owner,
      { taskId: root.id },
      { kind: 'comment', text: 'Previous occurrence comment' },
    );
    await service.addEvent(
      owner,
      { taskId: child.id },
      { kind: 'time', text: 'Previous occurrence time', minutes: 20 },
    );
    const attachments = await prisma.withTenant(owner.tenantId, async (tx) => {
      const files = [];
      for (const task of [root, grandchild])
        files.push(
          await tx.spPlannerAttachment.create({
            data: {
              id: randomUUID(),
              tenantId: owner.tenantId,
              taskId: task.id,
              uploadedBy: owner.clerkUserId,
              fileName: 'Recurring QA.txt',
              sizeBytes: 1,
              objectKey: `tenants/${owner.tenantId}/planner/tasks/${task.id}/${randomUUID()}`,
            },
          }),
        );
      await tx.spPlannerAttachment.create({
        data: {
          id: randomUUID(),
          tenantId: owner.tenantId,
          taskId: child.id,
          uploadedBy: owner.clerkUserId,
          fileName: 'Archived QA.txt',
          sizeBytes: 1,
          objectKey: 'local-archived-qa',
          archived: true,
        },
      });
      return files;
    });
    await service.saveTask(owner, root.id, { version: root.version, data: { status: 'done' } });
    const rows = (await service.tasks(owner, { projectId: p.id })).items;
    expect(rows).toHaveLength(6);
    const next = rows.find((t) => t.name === root.name && t.id !== root.id)!;
    const nextChild = rows.find((t) => t.parentId === next.id)!;
    const nextGrandchild = rows.find((t) => t.parentId === nextChild.id)!;
    expect(next).toMatchObject({ status: 'todo', dueOn: '2026-10-13', actualMinutes: 0 });
    expect(nextChild).toMatchObject({ status: 'todo', dueOn: child.dueOn, actualMinutes: 0 });
    expect(nextGrandchild.dependencies).toEqual([next.id]);
    expect(
      (await service.events(owner, { taskId: next.id })).some((e) =>
        ['comment', 'time'].includes(e.kind),
      ),
    ).toBe(false);
    const copied = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerAttachment.findMany({
        where: {
          tenantId: owner.tenantId,
          taskId: { in: [next.id, nextChild.id, nextGrandchild.id] },
        },
      }),
    );
    expect(copied).toHaveLength(2);
    expect(copied.map((f) => f.objectKey).sort()).toEqual(
      attachments.map((f) => f.objectKey).sort(),
    );
    expect(copied.every((f) => attachments.every((source) => source.id !== f.id))).toBe(true);
    await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerAttachment.update({
        where: { id: attachments[0]!.id },
        data: { archived: true },
      }),
    );
    expect(
      await prisma.withTenant(owner.tenantId, (tx) =>
        tx.spPlannerAttachment.count({ where: { taskId: next.id, archived: false } }),
      ),
    ).toBe(1);
    await expect(service.task(outsider, nextGrandchild.id)).rejects.toMatchObject({ status: 404 });
  });
  it('rolls back recurring completion if a descendant is inaccessible', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: `Restricted recurrence ${randomUUID()}` },
    });
    const root = await service.saveTask(owner, null, {
      data: {
        name: 'Restricted recurrence root',
        assigneeId: viewer.clerkUserId,
        dueOn: '2026-10-06',
        recurrence: { frequency: 'daily', interval: 1 },
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    await service.saveTask(owner, null, { data: { name: 'Restricted child', parentId: root.id } });
    await expect(
      service.saveTask(viewer, root.id, { version: root.version, data: { status: 'done' } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.task(owner, root.id)).toMatchObject({
      version: root.version,
      status: 'todo',
    });
    expect((await service.tasks(owner, { projectId: p.id })).items).toHaveLength(2);
  });
  it('requires a template reference date, skips weekends and shifts timed repeats while preserving its source', async () => {
    const template = await service.saveResource(owner, null, {
      kind: 'template',
      name: `Relative QA ${randomUUID()}`,
      data: {
        description: '',
        privacy: 'private',
        members: [],
        project: { ...PLANNER_DEFAULT_PROJECT, name: 'Relative source', privacy: 'team' },
        tasks: [
          {
            ...PLANNER_DEFAULT_TASK,
            name: 'Relative repeat',
            startOn: '2026-10-06',
            dueOn: '2026-10-07',
            dueTime: '09:00',
            timeZone: 'America/New_York',
            recurrence: { frequency: 'weekly', interval: 1, endsOn: '2026-10-21' },
          },
        ],
        schedule: {
          anchor: 'due',
          skipWeekends: true,
          dates: [{ startOffset: -2, dueOffset: -1 }],
        },
      },
    });
    await expect(
      service.instantiateTemplate(owner, template.id, { name: 'Missing date' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.instantiateTemplate(owner, template.id, {
        name: 'Invalid date',
        anchorOn: '2026-02-30',
      }),
    ).rejects.toMatchObject({ status: 400 });
    const p = await service.instantiateTemplate(owner, template.id, {
      name: 'Relative deployed QA',
      anchorOn: '2026-10-12',
    });
    expect(p).toMatchObject({ privacy: 'private', startOn: '2026-10-08', dueOn: '2026-10-12' });
    expect((await service.tasks(owner, { projectId: p.id })).items[0]).toMatchObject({
      startOn: '2026-10-08',
      dueOn: '2026-10-09',
      dueTime: '09:00',
      timeZone: 'America/New_York',
      recurrence: { anchorOn: '2026-10-09', endsOn: '2026-10-23' },
    });
    const unchanged = (await service.resources(owner)).find((r) => r.id === template.id)!;
    expect(unchanged.version).toBe(template.version);
    expect(unchanged.data).toEqual(template.data);
    await expect(
      service.task(outsider, (await service.tasks(owner, { projectId: p.id })).items[0]!.id),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('creates a single timed successor across concurrent completion and reopen, preserving its month-end anchor', async () => {
    const sectionId = randomUUID();
    const p = await service.saveProject(owner, null, {
      data: {
        name: `Recurring QA ${randomUUID()}`,
        sections: [{ id: sectionId, name: 'Recurring work' }],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Timed monthly recurrence',
        startOn: '2028-01-29',
        dueOn: '2028-01-31',
        startTime: '08:00',
        dueTime: '09:00',
        timeZone: 'America/New_York',
        memberships: [{ projectId: p.id, sectionId, position: 0 }],
        recurrence: { frequency: 'monthly', interval: 1, endsOn: '2028-03-31' },
      },
    });
    const completions = await Promise.allSettled(
      [1, 2].map(() =>
        service.saveTask(owner, t.id, {
          version: t.version,
          data: { status: 'done' },
        }),
      ),
    );
    expect(completions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(completions.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { status: 409 },
    });
    let completed = await service.task(owner, t.id);
    expect(completed).not.toHaveProperty('recurrenceSuccessorId');
    await service.reorderTasks(owner, p.id, {
      tasks: [{ id: completed.id, version: completed.version }],
    });
    await service.saveProject(owner, p.id, { version: p.version, data: { sections: [] } });
    completed = await service.task(owner, t.id);
    const reopened = await service.saveTask(owner, t.id, {
      version: completed.version,
      data: { status: 'todo' },
    });
    completed = await service.saveTask(owner, t.id, {
      version: reopened.version,
      data: { status: 'done' },
    });
    let page = await service.tasks(owner, { projectId: p.id });
    expect(page.items).toHaveLength(2);
    const next = page.items.find((item) => item.id !== t.id)!;
    expect(next).toMatchObject({
      startOn: '2028-02-27',
      dueOn: '2028-02-29',
      dueTime: '09:00',
      timeZone: 'America/New_York',
      recurrence: { anchorOn: '2028-01-31' },
    });
    await service.saveTask(owner, next.id, { version: next.version, data: { status: 'done' } });
    page = await service.tasks(owner, { projectId: p.id });
    const last = page.items.find((item) => item.status === 'todo')!;
    expect(last.dueOn).toBe('2028-03-31');
    await service.saveTask(owner, last.id, { version: last.version, data: { status: 'done' } });
    expect((await service.tasks(owner, { projectId: p.id })).items).toHaveLength(3);
    await expect(service.task(outsider, next.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.saveTask(owner, completed.id, {
        version: completed.version,
        data: { recurrenceSuccessorId: randomUUID() },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('keeps personal sections private, versioned, and independent of shared project membership', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Shared section unaffected',
        privacy: 'team',
        sections: [{ id: randomUUID(), name: 'Shared inbox' }],
      },
    });
    const sectionId = p.sections[0]!.id;
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'My task placement',
        assigneeId: owner.clerkUserId,
        memberships: [{ projectId: p.id, sectionId, position: 7 }],
      },
    });
    const personalSection = randomUUID();
    const existing = (await service.resources(owner)).find((r) => r.kind === 'my_tasks');
    const config = await service.saveResource(owner, existing?.id ?? null, {
      kind: 'my_tasks',
      version: existing?.version,
      name: 'My tasks settings',
      data: {
        sections: [{ id: personalSection, name: 'Focus' }],
        placements: [{ taskId: t.id, sectionId: personalSection, position: 0 }],
      },
    });
    expect((await service.task(owner, t.id)).memberships).toEqual(t.memberships);
    expect((await service.task(owner, t.id)).version).toBe(t.version);
    expect((await service.resources(viewer)).some((r) => r.id === config.id)).toBe(false);
    await expect(
      service.saveResource(viewer, config.id, {
        version: config.version,
        name: 'Cannot change settings',
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.saveResource(owner, null, {
        kind: 'my_tasks',
        name: 'Duplicate settings',
        data: config.data,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveResource(owner, config.id, {
        version: config.version - 1,
        name: 'Stale settings',
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveResource(owner, null, {
        kind: 'saved_view',
        projectId: p.id,
        name: 'Shared personal view',
        data: {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    const otherTask = await service.saveTask(viewer, null, {
      data: { name: 'Other assigned work', assigneeId: viewer.clerkUserId },
    });
    await expect(
      service.saveResource(owner, config.id, {
        version: config.version,
        data: { placements: [{ taskId: otherTask.id, sectionId: personalSection, position: 0 }] },
      }),
    ).rejects.toMatchObject({ status: 400 });
    await service.saveTask(owner, t.id, {
      version: t.version,
      data: { assigneeId: viewer.clerkUserId },
    });
    expect(
      (await service.resources(owner)).find((r) => r.id === config.id)!.data.placements,
    ).toEqual([]);
    const cleared = await service.saveResource(owner, config.id, {
      version: config.version,
      data: { placements: [] },
    });
    expect(cleared.version).toBe(config.version + 1);
  });
  it('pages activity without losing tied timestamps or duplicating rows after a new update', async () => {
    const t = await service.saveTask(owner, null, { data: { name: 'Activity pagination' } });
    const ids = Array.from({ length: 201 }, () => randomUUID())
      .sort()
      .reverse();
    await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerEvent.createMany({
        data: ids.map((id) => ({
          id,
          tenantId: owner.tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'comment',
          text: `Page ${id}`,
          createdAt: new Date('2030-01-01T00:00:00.123Z'),
        })),
      }),
    );
    const first = await service.events(owner, { taskId: t.id }, { paged: 'true' });
    if (Array.isArray(first)) throw new Error('Expected paginated activity');
    expect(first.items.map((e) => e.id)).toEqual(ids.slice(0, 100));
    const newest = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerEvent.create({
        data: {
          tenantId: owner.tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'comment',
          text: 'Arrived between pages',
          createdAt: new Date('2031-01-01T00:00:00Z'),
        },
      }),
    );
    const second = await service.events(
      owner,
      { taskId: t.id },
      { paged: 'true', cursor: first.nextCursor! },
    );
    if (Array.isArray(second)) throw new Error('Expected paginated activity');
    expect(second.items.map((e) => e.id)).toEqual(ids.slice(100, 200));
    const third = await service.events(
      owner,
      { taskId: t.id },
      { paged: 'true', cursor: second.nextCursor! },
    );
    if (Array.isArray(third)) throw new Error('Expected paginated activity');
    expect(third.items[0]!.id).toBe(ids[200]);
    expect(third.nextCursor).toBeNull();
    const collected = [...first.items, ...second.items, ...third.items].map((e) => e.id);
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).not.toContain(newest.id);
    expect(await service.events(owner, { taskId: t.id })).toHaveLength(100);
    const other = await service.saveTask(owner, null, {
      data: { name: 'Different activity target' },
    });
    await expect(
      service.events(owner, { taskId: other.id }, { paged: 'true', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.events(outsider, { taskId: t.id }, { paged: 'true', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('advances an entirely revoked inbox page and isolates archived and other-user cursors', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Revoked paginated inbox',
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
      },
    });
    const revoked = await service.saveTask(owner, null, {
      data: {
        name: 'Hidden after revocation',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const visible = await service.saveTask(owner, null, {
      data: { name: 'Older authorized update', assigneeId: viewer.clerkUserId },
    });
    const hiddenEvents: string[] = Array.from({ length: 100 }, () => randomUUID());
    const visibleEvent = randomUUID();
    const archivedEvent = randomUUID();
    const newestTime = Date.now() + 315360000000;
    await prisma.withTenant(owner.tenantId, async (tx) => {
      await tx.spPlannerInbox.updateMany({
        where: { tenantId: owner.tenantId, userId: viewer.clerkUserId },
        data: { archived: true },
      });
      await tx.spPlannerEvent.createMany({
        data: [
          ...hiddenEvents.map((id) => ({
            id,
            tenantId: owner.tenantId,
            actorId: owner.clerkUserId,
            taskId: revoked.id,
            kind: 'comment',
            text: 'Private revoked update',
            createdAt: new Date(newestTime),
          })),
          {
            id: visibleEvent,
            tenantId: owner.tenantId,
            actorId: owner.clerkUserId,
            taskId: visible.id,
            kind: 'comment',
            text: 'Older authorized update',
            createdAt: new Date(newestTime - 1),
          },
          {
            id: archivedEvent,
            tenantId: owner.tenantId,
            actorId: owner.clerkUserId,
            taskId: visible.id,
            kind: 'comment',
            text: 'Archived authorized update',
            createdAt: new Date(newestTime + 1),
          },
        ],
      });
      await tx.spPlannerInbox.createMany({
        data: [...hiddenEvents, visibleEvent, archivedEvent].map((eventId) => ({
          tenantId: owner.tenantId,
          userId: viewer.clerkUserId,
          eventId,
          archived: eventId === archivedEvent,
        })),
      });
    });
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    const first = await service.inbox(viewer, { paged: 'true', archived: 'false' });
    if (Array.isArray(first)) throw new Error('Expected paginated inbox');
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.inbox(viewer, {
      paged: 'true',
      archived: 'false',
      cursor: first.nextCursor!,
    });
    if (Array.isArray(second)) throw new Error('Expected paginated inbox');
    expect(second.items[0]!.event.id).toBe(visibleEvent);
    expect(
      second.items.some(
        (item) => hiddenEvents.includes(item.event.id) || item.event.id === archivedEvent,
      ),
    ).toBe(false);
    await expect(
      service.inbox(owner, { paged: 'true', cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.inbox(
        { ...viewer, tenantId: '10000000-0000-4000-8000-000000000002' },
        { paged: 'true', cursor: first.nextCursor! },
      ),
    ).rejects.toMatchObject({ status: 400 });
    const archive = await service.inbox(viewer, { paged: 'true', archived: 'true' });
    if (Array.isArray(archive)) throw new Error('Expected paginated inbox');
    expect(archive.items.some((item) => item.event.id === archivedEvent)).toBe(true);
    expect(archive.items.every((item) => item.archived)).toBe(true);
  });
  it('persists projects/tasks/comments and filters private work on every read', async () => {
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Private integration project',
        members: [{ userId: 'user_viewer', role: 'viewer' }],
      },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Private task',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    expect((await service.task(viewer, t.id)).name).toBe('Private task');
    await expect(service.task(outsider, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.saveTask(viewer, t.id, { version: 1, data: { name: 'Cannot edit' } }),
    ).rejects.toMatchObject({ status: 403 });
    await service.addEvent(
      owner,
      { taskId: t.id },
      { kind: 'comment', text: 'Persisted integration comment' },
    );
    expect(
      (await service.events(viewer, { taskId: t.id })).some(
        (e) => e.text === 'Persisted integration comment',
      ),
    ).toBe(true);
    await service.saveProject(owner, p.id, { version: p.version, data: { members: [] } });
    await expect(service.events(viewer, { taskId: t.id })).rejects.toMatchObject({ status: 404 });
    expect((await service.tasks(outsider, {})).items.some((row) => row.id === t.id)).toBe(false);
  });
  it('supports the production application role while RLS filters raw reads and activity stays append-only', async () => {
    await prisma.withTenant(owner.tenantId, async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE capiro_app');
      const p = await tx.spPlannerProject.create({
        data: {
          tenantId: owner.tenantId,
          ownerId: owner.clerkUserId,
          data: JSON.parse(
            JSON.stringify({ ...PLANNER_DEFAULT_PROJECT, name: 'Runtime role project' }),
          ) as Prisma.InputJsonValue,
        },
      });
      const t = await tx.spPlannerTask.create({
        data: {
          tenantId: owner.tenantId,
          ownerId: owner.clerkUserId,
          projectIds: [p.id],
          data: {
            ...PLANNER_DEFAULT_TASK,
            name: 'Runtime role task',
            memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
          },
        },
      });
      const e = await tx.spPlannerEvent.create({
        data: {
          tenantId: owner.tenantId,
          actorId: owner.clerkUserId,
          taskId: t.id,
          kind: 'comment',
          text: 'Runtime role comment',
        },
      });
      await tx.spPlannerInbox.create({
        data: { tenantId: owner.tenantId, userId: viewer.clerkUserId, eventId: e.id },
      });
      await tx.spPlannerResource.create({
        data: {
          tenantId: owner.tenantId,
          ownerId: owner.clerkUserId,
          kind: 'capacity',
          name: 'Capacity',
          data: { userId: owner.clerkUserId, weeklyMinutes: 2400 },
        },
      });
      await tx.spPlannerAttachment.create({
        data: {
          tenantId: owner.tenantId,
          taskId: t.id,
          uploadedBy: owner.clerkUserId,
          fileName: 'QA.txt',
          sizeBytes: 1,
          objectKey: `tenants/${owner.tenantId}/planner/tasks/${t.id}/qa`,
        },
      });
      await tx.spPlannerTask.update({
        where: { tenantId: owner.tenantId, id: t.id },
        data: { archived: true },
      });
      const tenants = await tx.$queryRaw<
        { tenant_id: string }[]
      >`SELECT DISTINCT tenant_id FROM sp_planner_projects`;
      expect(tenants.every((row) => row.tenant_id === owner.tenantId)).toBe(true);
      const rights = await tx.$queryRaw<
        { can_update: boolean; can_delete: boolean }[]
      >`SELECT has_table_privilege('capiro_app', 'sp_planner_events', 'UPDATE') AS can_update, has_table_privilege('capiro_app', 'sp_planner_events', 'DELETE') AS can_delete`;
      expect(rights[0]).toEqual({ can_update: false, can_delete: false });
      const tableRights = await tx.$queryRaw<
        { relname: string; relforcerowsecurity: boolean; can_delete: boolean }[]
      >`SELECT relname, relforcerowsecurity, has_table_privilege('capiro_app', oid, 'DELETE') AS can_delete FROM pg_class WHERE relkind='r' AND relname LIKE 'sp_planner_%' ORDER BY relname`;
      expect(tableRights).toHaveLength(8);
      expect(tableRights.every((row) => row.relforcerowsecurity && !row.can_delete)).toBe(true);
    });
  });
  it('shares only form questions and a receipt, enforces tenant scope, quotas and revocation', async () => {
    const p = await service.saveProject(owner, null, { data: { name: 'Secret intake project' } });
    const fieldId = crypto.randomUUID();
    const form = await service.saveResource(owner, null, {
      kind: 'form',
      projectId: p.id,
      name: 'Public intake',
      data: {
        description: 'Describe the request',
        enabled: true,
        fields: [
          {
            id: fieldId,
            label: 'Request',
            type: 'text',
            required: true,
            options: [],
            taskField: 'name',
          },
        ],
        defaults: {
          assigneeId: owner.clerkUserId,
          priority: 'none',
          status: 'todo',
          estimateMinutes: 0,
        },
      },
    });
    await expect(
      service.shareForm(outsider, form.id, { version: 1, enabled: true }),
    ).rejects.toMatchObject({ status: 404 });
    const first = (await service.shareForm(owner, form.id, { version: 1, enabled: true })).token!;
    expect(await service.publicForm(first)).toEqual({
      name: 'Public intake',
      description: 'Describe the request',
      confirmationMessage: undefined,
      allowAnotherSubmission: undefined,
      fields: [
        {
          id: fieldId,
          label: 'Request',
          type: 'text',
          required: true,
          options: [],
          maxLength: 500,
        },
      ],
    });
    const stored = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerResource.findFirst({ where: { id: form.id } }),
    );
    expect(stored?.shareTokenHash).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(first);
    await expect(
      service.publicForm(first.replace(owner.tenantId, '10000000-0000-4000-8000-000000000002')),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.submitPublicForm(first, { [fieldId]: 'Request', memberships: [] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(await service.submitPublicForm(first, { [fieldId]: 'Anonymous request' })).toEqual({
      received: true,
    });
    const submitted = (await service.tasks(owner, { projectId: p.id })).items[0]!;
    expect(submitted.ownerId).toBe(owner.clerkUserId);
    expect(submitted.name).toBe('Anonymous request');
    for (let i = 1; i < 10; i++)
      await service.submitPublicForm(first, { [fieldId]: `Anonymous ${i}` });
    await expect(
      service.submitPublicForm(first, { [fieldId]: 'Rate limited' }),
    ).rejects.toMatchObject({ status: 429 });
    const second = (await service.shareForm(owner, form.id, { version: 2, enabled: true })).token!;
    expect(second).not.toBe(first);
    await expect(service.publicForm(first)).rejects.toMatchObject({ status: 404 });
    await service.shareForm(owner, form.id, { version: 3, enabled: false });
    await expect(service.publicForm(second)).rejects.toMatchObject({ status: 404 });
  });
  it('copies a project without leaking private memberships, fields or external graph links', async () => {
    const s = crypto.randomUUID(),
      f = crypto.randomUUID();
    const p = await service.saveProject(owner, null, {
      data: {
        name: 'Copy source',
        privacy: 'team',
        sections: [{ id: s, name: 'Prepare' }],
        fields: [{ id: f, name: 'Budget', type: 'number', options: [] }],
      },
    });
    const a = await service.saveTask(owner, null, {
      data: {
        name: 'Source parent',
        customValues: { [f]: 50 },
        memberships: [{ projectId: p.id, sectionId: s, position: 0 }],
      },
    });
    await service.saveTask(owner, null, {
      data: { name: 'Source child', parentId: a.id, dependencies: [a.id] },
    });
    const copy = await service.duplicateProject(viewer, p.id, { name: 'Private copy' });
    expect(copy.ownerId).toBe(viewer.clerkUserId);
    expect(copy.privacy).toBe('private');
    expect(copy.sections[0]?.id).not.toBe(s);
    expect(copy.fields[0]?.id).not.toBe(f);
    const rows = (await service.tasks(viewer, { projectId: copy.id })).items;
    const parent = rows.find((t) => t.name === a.name)!;
    const child = rows.find((t) => t.name === 'Source child')!;
    expect(child.parentId).toBe(parent.id);
    expect(child.dependencies).toEqual([parent.id]);
    expect(parent.customValues[copy.fields[0]!.id]).toBe(50);
    await expect(service.tasks(owner, { projectId: copy.id })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('returns the earliest assigned due dates to the Dashboard without UUID pagination bias', async () => {
    const personId = crypto.randomUUID(),
      queueUserId = `user_queue_${personId}`;
    await prisma.withTenant(owner.tenantId, async (tx) => {
      await tx.$executeRaw`INSERT INTO users (id, clerk_user_id, first_name, last_name, email) VALUES (${personId}::uuid, ${queueUserId}, 'Queue', 'QA', 'queue@example.test')`;
      await tx.$executeRaw`INSERT INTO tenant_memberships (tenant_id, user_id, status) VALUES (${owner.tenantId}::uuid, ${personId}::uuid, 'active')`;
    });
    const p = await service.saveProject(owner, null, {
      data: { name: 'Queue project', privacy: 'team' },
    });
    await service.saveTask(owner, null, {
      data: {
        name: 'Future queue item',
        assigneeId: queueUserId,
        dueOn: '2099-01-01',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const early = await service.saveTask(owner, null, {
      data: {
        name: 'Earliest queue item',
        assigneeId: queueUserId,
        dueOn: '1900-01-01',
        memberships: [{ projectId: p.id, sectionId: null, position: 1 }],
      },
    });
    expect((await service.queue({ ...owner, clerkUserId: queueUserId }))[0]?.id).toBe(early.id);
  });
  it('applies a task order atomically and rolls back stale versions', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: 'Order project', members: [{ userId: viewer.clerkUserId, role: 'viewer' }] },
    });
    const a = await service.saveTask(owner, null, {
      data: { name: 'Order A', memberships: [{ projectId: p.id, sectionId: null, position: 0 }] },
    });
    const b = await service.saveTask(owner, null, {
      data: { name: 'Order B', memberships: [{ projectId: p.id, sectionId: null, position: 1 }] },
    });
    await expect(
      service.reorderTasks(viewer, p.id, {
        tasks: [
          { id: b.id, version: 1 },
          { id: a.id, version: 1 },
        ],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await service.reorderTasks(owner, p.id, {
      tasks: [
        { id: b.id, version: 1 },
        { id: a.id, version: 1 },
      ],
    });
    expect((await service.task(owner, a.id)).memberships[0]?.position).toBe(1000);
    await expect(
      service.reorderTasks(owner, p.id, {
        tasks: [
          { id: a.id, version: 2 },
          { id: b.id, version: 1 },
        ],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.task(owner, a.id)).version).toBe(2);
  });
  it('notifies mentioned people only if they already have access to the task', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: 'Mention project', members: [{ userId: viewer.clerkUserId, role: 'viewer' }] },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Mention task',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    const e = await service.addEvent(
      owner,
      { taskId: t.id },
      {
        kind: 'comment',
        text: 'Please review',
        mentions: [viewer.clerkUserId, outsider.clerkUserId],
      },
    );
    const deliveries = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerInbox.findMany({ where: { eventId: e.id } }),
    );
    expect(deliveries.map((d) => d.userId)).toEqual([viewer.clerkUserId]);
  });
  it.each(['approved', 'rejected', 'changes_requested'])(
    'completes a resolved approval (%s) and clears it when reopened',
    async (approval) => {
      const task = await service.saveTask(owner, null, {
        data: { name: 'Approval test', subtype: 'approval' },
      });
      const resolved = await service.saveTask(owner, task.id, { version: 1, data: { approval } });
      expect(resolved.status).toBe('done');
      expect(resolved.completedAt).not.toBeNull();
      const reopened = await service.saveTask(owner, task.id, {
        version: 2,
        data: { status: 'todo' },
      });
      expect(reopened.approval).toBe('pending');
      expect(reopened.completedAt).toBeNull();
    },
  );
  it('allows exactly one competing write at an expected version', async () => {
    const t = await service.saveTask(owner, null, { data: { name: 'Concurrent personal task' } });
    const results = await Promise.allSettled([
      service.saveTask(owner, t.id, { version: 1, data: { name: 'First' } }),
      service.saveTask(owner, t.id, { version: 1, data: { name: 'Second' } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 409 });
    expect((await service.task(owner, t.id)).version).toBe(2);
  });
  it('serializes competing graph writes so their combination cannot create a cycle', async () => {
    const a = await service.saveTask(owner, null, { data: { name: 'Graph A' } });
    const b = await service.saveTask(owner, null, { data: { name: 'Graph B' } });
    const results = await Promise.allSettled([
      service.saveTask(owner, a.id, { version: 1, data: { dependencies: [b.id] } }),
      service.saveTask(owner, b.id, { version: 1, data: { dependencies: [a.id] } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(failure.reason).toMatchObject({ status: 400 });
  });
  it('creates a successor once and stores calendar dates without timezone shifts', async () => {
    const name = `Recurring real task ${crypto.randomUUID()}`;
    const t = await service.saveTask(owner, null, {
      data: {
        ...PLANNER_DEFAULT_TASK,
        name,
        dueOn: '2026-01-31',
        recurrence: { frequency: 'monthly', interval: 1 },
      },
    });
    await service.saveTask(owner, t.id, { version: 1, data: { status: 'done' } });
    const rows = (await service.tasks(owner, { search: name })).items.filter(
      (row) => row.name === name,
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.status === 'todo')?.dueOn).toBe('2026-02-28');
    await service.saveTask(owner, t.id, { version: 2, data: { status: 'done' } });
    expect(
      (await service.tasks(owner, { search: name })).items.filter((row) => row.name === name),
    ).toHaveLength(2);
  });
  it('cannot read another tenant using task and project ids', async () => {
    const foreign = {
      ...owner,
      tenantId: '10000000-0000-4000-8000-000000000002',
      clerkUserId: 'user_foreign',
    };
    const p = await service.saveProject(foreign, null, {
      data: { name: 'Other tenant', privacy: 'team' },
    });
    const t = await service.saveTask(foreign, null, {
      data: {
        name: 'Other tenant task',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    await expect(service.task(owner, t.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.tasks(owner, { projectId: p.id })).rejects.toMatchObject({ status: 404 });
    expect((await service.bootstrap(owner)).projects.some((project) => project.id === p.id)).toBe(
      false,
    );
  });
  it('runs project rules and allows a viewer to submit a constrained form without task edit rights', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: 'Rules/forms test', members: [{ userId: 'user_viewer', role: 'viewer' }] },
    });
    const rule = await service.saveResource(owner, null, {
      kind: 'rule',
      projectId: p.id,
      name: 'Flag new requests',
      data: { enabled: true, trigger: 'created', conditions: {}, actions: { priority: 'high' } },
    });
    const t = await service.saveTask(owner, null, {
      data: {
        name: 'Rule example',
        memberships: [{ projectId: p.id, sectionId: null, position: 0 }],
      },
    });
    expect(t.priority).toBe('high');
    await expect(
      service.saveResource(viewer, rule.id, { version: 1, data: { enabled: false } }),
    ).rejects.toMatchObject({ status: 403 });
    const fieldId = crypto.randomUUID();
    const form = await service.saveResource(owner, null, {
      kind: 'form',
      projectId: p.id,
      name: 'Request work',
      data: {
        description: '',
        enabled: true,
        fields: [
          {
            id: fieldId,
            label: 'Name',
            type: 'text',
            required: true,
            options: [],
            taskField: 'name',
          },
        ],
        defaults: { assigneeId: null, status: 'todo', priority: 'none', estimateMinutes: 0 },
      },
    });
    await expect(
      service.submitForm(outsider, form.id, { [fieldId]: 'Unauthorized' }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.submitForm(viewer, form.id, { [fieldId]: 'Valid', unknown: 'extra' }),
    ).rejects.toMatchObject({ status: 400 });
    const submitted = await service.submitForm(viewer, form.id, { [fieldId]: 'Viewer request' });
    expect(submitted.name).toBe('Viewer request');
    expect(submitted.priority).toBe('high');
    expect(submitted.memberships[0]!.projectId).toBe(p.id);
    await expect(
      service.saveTask(viewer, submitted.id, { version: 1, data: { name: 'Cannot edit' } }),
    ).rejects.toMatchObject({ status: 403 });
    await service.saveResource(owner, form.id, { version: form.version, data: { enabled: false } });
    await expect(
      service.submitForm(viewer, form.id, { [fieldId]: 'Closed' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('redacts inaccessible portfolio projects and preserves them through an authorized name edit', async () => {
    const p = await service.saveProject(owner, null, {
      data: { name: 'Hidden portfolio project' },
    });
    const portfolio = await service.saveResource(owner, null, {
      kind: 'portfolio',
      name: 'Team portfolio',
      data: { description: '', privacy: 'team', members: [], projectIds: [p.id] },
    });
    const resources = await service.resources(outsider);
    expect(resources.find((r) => r.id === portfolio.id)?.data.projectIds).toEqual([]);
    await expect(
      service.saveResource(outsider, portfolio.id, { version: 1, data: { projectIds: [p.id] } }),
    ).rejects.toMatchObject({ status: 404 });
    await service.saveResource(outsider, portfolio.id, {
      version: 1,
      name: 'Renamed portfolio',
      data: { projectIds: [] },
    });
    expect(
      (await service.resources(owner)).find((r) => r.id === portfolio.id)?.data.projectIds,
    ).toEqual([p.id]);
  });
  it('copies a template graph with fresh task, section and custom field identities', async () => {
    const sectionId = crypto.randomUUID(),
      fieldId = crypto.randomUUID();
    const template = await service.saveResource(owner, null, {
      kind: 'template',
      name: 'Graph template',
      data: {
        description: '',
        privacy: 'private',
        members: [],
        project: {
          ...PLANNER_DEFAULT_PROJECT,
          name: 'Blueprint',
          sections: [{ id: sectionId, name: 'Plan' }],
          fields: [{ id: fieldId, name: 'Budget', type: 'number', options: [] }],
        },
        tasks: [
          { ...PLANNER_DEFAULT_TASK, name: 'Parent', customValues: { [fieldId]: 100 } },
          { ...PLANNER_DEFAULT_TASK, name: 'Child' },
          { ...PLANNER_DEFAULT_TASK, name: 'Dependent' },
        ],
        layout: [
          { sectionId, parentIndex: null, dependencyIndices: [] },
          { sectionId, parentIndex: 0, dependencyIndices: [] },
          { sectionId: null, parentIndex: null, dependencyIndices: [1] },
        ],
      },
    });
    await expect(
      service.instantiateTemplate(outsider, template.id, { name: 'Unauthorized copy' }),
    ).rejects.toMatchObject({ status: 404 });
    const p = await service.instantiateTemplate(owner, template.id, { name: 'Copied graph' });
    const rows = (await service.tasks(owner, { projectId: p.id })).items;
    const parent = rows.find((t) => t.name === 'Parent')!,
      child = rows.find((t) => t.name === 'Child')!,
      dependent = rows.find((t) => t.name === 'Dependent')!;
    expect(rows).toHaveLength(3);
    expect(p.sections[0]!.id).not.toBe(sectionId);
    expect(p.fields[0]!.id).not.toBe(fieldId);
    expect(parent.customValues[p.fields[0]!.id]).toBe(100);
    expect(child.parentId).toBe(parent.id);
    expect(dependent.dependencies).toEqual([child.id]);
    expect(parent.memberships[0]!.sectionId).toBe(p.sections[0]!.id);
  });
  it('rejects cross-tenant attachment metadata at the database foreign key', async () => {
    const t = await service.saveTask(owner, null, { data: { name: 'Attachment FK test' } });
    await expect(
      prisma.withTenant('10000000-0000-4000-8000-000000000002', (tx) =>
        tx.spPlannerAttachment.create({
          data: {
            tenantId: '10000000-0000-4000-8000-000000000002',
            taskId: t.id,
            uploadedBy: 'user_foreign',
            fileName: 'test.txt',
            sizeBytes: 5,
            objectKey: 'synthetic',
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
