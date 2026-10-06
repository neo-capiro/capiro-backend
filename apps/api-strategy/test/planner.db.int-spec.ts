import { PlannerService } from '../src/planner/planner.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import { PLANNER_DEFAULT_TASK, PLANNER_DEFAULT_PROJECT } from '@capiro/strategy-verifier';
import { Prisma } from '../generated/prisma-client/index.js';

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
      fields: form.data.fields,
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
