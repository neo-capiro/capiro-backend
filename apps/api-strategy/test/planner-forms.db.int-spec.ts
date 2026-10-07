import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PlannerService } from '../src/planner/planner.service.js';
import { PlannerFormFilesService } from '../src/planner/planner-form-files.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { PlannerLinksService } from '../src/planner/planner-links.service.js';
import type { AuthTenantContext } from '../src/auth/tenant-context.js';
import type { PlannerFormData, PlannerFormField, PlannerResource } from '@capiro/strategy-verifier';

const testUrl = process.env.PLANNER_TEST_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/planner_qa')
    throw new Error('Planner DB tests require the dedicated localhost planner_qa database');
}
const describeDb = testUrl ? describe : describe.skip;
describeDb('Planner rich forms with real tenant transactions', () => {
  let prisma: PrismaService, service: PlannerService, send: jest.SpyInstance;
  const priorBucket = process.env.ASSETS_BUCKET;
  const owner: AuthTenantContext = {
    tenantId: '10000000-0000-4000-8000-000000000001',
    clerkUserId: 'user_owner',
    role: 'org:admin',
  };
  const viewer = { ...owner, clerkUserId: 'user_viewer' };
  beforeAll(async () => {
    prisma = new PrismaService({ datasources: { db: { url: testUrl! } } });
    await prisma.$connect();
    service = new PlannerService(
      prisma,
      { validate: async () => undefined } as unknown as PlannerLinksService,
      new PlannerFormFilesService(),
    );
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(() => {
    process.env.ASSETS_BUCKET = 'synthetic-planner-qa';
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  });
  afterEach(() => {
    send.mockRestore();
    if (priorBucket === undefined) delete process.env.ASSETS_BUCKET;
    else process.env.ASSETS_BUCKET = priorBucket;
  });
  async function intake() {
    const sectionId = randomUUID(),
      customFieldId = randomUUID();
    const project = await service.saveProject(owner, null, {
      data: {
        name: `Synthetic rich form ${randomUUID()}`,
        members: [{ userId: viewer.clerkUserId, role: 'viewer' }],
        sections: [{ id: sectionId, name: 'Intake' }],
        fields: [
          {
            id: customFieldId,
            name: 'Request type',
            type: 'multi_select',
            options: ['Design', 'Engineering'],
          },
        ],
      },
    });
    const choiceId = randomUUID(),
      titleId = randomUUID(),
      fileId = randomUUID();
    const fields: PlannerFormField[] = [
      {
        id: choiceId,
        label: 'Request type',
        type: 'multi_select',
        options: ['Design', 'Engineering'],
        taskField: 'custom',
        customFieldId,
        required: true,
      },
      { id: titleId, label: 'Request', type: 'text', options: [], taskField: null, required: true },
      {
        id: fileId,
        label: 'Reference files',
        type: 'attachment',
        options: [],
        taskField: 'attachments',
        required: true,
        multiple: true,
        showWhen: { questionId: choiceId, values: ['Engineering'] },
      },
    ];
    const data: PlannerFormData = {
      description: 'Synthetic only',
      enabled: true,
      fields,
      titleFieldId: titleId,
      sectionId,
      copyAnswersToDescription: true,
      addSubmitterAsCollaborator: true,
      audience: 'public',
      allowAnotherSubmission: true,
      confirmationMessage: 'Saved',
      defaults: {
        assigneeId: owner.clerkUserId,
        status: 'todo',
        priority: 'high',
        estimateMinutes: 12,
      },
    };
    const form = await service.saveResource(owner, null, {
      kind: 'form',
      projectId: project.id,
      name: `Synthetic intake ${randomUUID()}`,
      data,
    });
    const file = {
      fieldname: fileId,
      originalname: 'synthetic.txt',
      buffer: Buffer.from('synthetic'),
      size: 9,
    };
    const answers = {
      [choiceId]: ['Engineering'],
      [titleId]: `Synthetic submitted ${randomUUID()}`,
    };
    return { project, form, sectionId, customFieldId, choiceId, titleId, fileId, file, answers };
  }
  async function noCreatedTask(name: string) {
    const count = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerTask.count({
        where: { tenantId: owner.tenantId, data: { path: ['name'], equals: name } },
      }),
    );
    expect(count).toBe(0);
  }
  it('atomically creates a viewer submission with current field mapping, section, defaults, collaborator, and private attachments', async () => {
    const q = await intake();
    const task = await service.submitForm(
      viewer,
      q.form.id,
      { answers: JSON.stringify(q.answers) },
      [q.file, { ...q.file, originalname: 'second.txt' }],
    );
    expect(task).toMatchObject({
      name: q.answers[q.titleId],
      priority: 'high',
      estimateMinutes: 12,
      collaborators: [viewer.clerkUserId],
      customValues: { [q.customFieldId]: ['Engineering'] },
      memberships: [{ projectId: q.project.id, sectionId: q.sectionId, position: 0 }],
    });
    expect(task.description).toContain('Reference files: synthetic.txt, second.txt');
    const files = await prisma.withTenant(owner.tenantId, (tx) =>
      tx.spPlannerAttachment.findMany({ where: { tenantId: owner.tenantId, taskId: task.id } }),
    );
    expect(files).toHaveLength(2);
    expect(
      files.every(
        (file) =>
          file.objectKey.startsWith(`tenants/${owner.tenantId}/planner/tasks/${task.id}/`) &&
          file.uploadedBy === viewer.clerkUserId,
      ),
    ).toBe(true);
    const events = await service.events(owner, { taskId: task.id });
    expect(events.filter((event) => event.text === `Submitted ${q.form.name}`)).toHaveLength(1);
  });
  it('accepts public attachments with a receipt only, drops hidden files, and never adds anonymous collaborators', async () => {
    const q = await intake();
    const token = (
      await service.shareForm(owner, q.form.id, { version: q.form.version, enabled: true })
    ).token!;
    const publicForm = await service.publicForm(token);
    expect(
      publicForm.fields.every((field) => !('taskField' in field) && !('customFieldId' in field)),
    ).toBe(true);
    expect(
      await service.submitPublicForm(token, { answers: JSON.stringify(q.answers) }, [q.file]),
    ).toEqual({ received: true });
    const rows = await service.tasks(owner, { projectId: q.project.id });
    expect(rows.items[0]?.collaborators).toEqual([]);
    send.mockClear();
    const hidden = { ...q.answers, [q.choiceId]: ['Design'], [q.titleId]: 'Hidden file response' };
    expect(await service.submitPublicForm(token, hidden, [q.file])).toEqual({ received: true });
    expect(send).not.toHaveBeenCalled();
    const task = (await service.tasks(owner, { projectId: q.project.id })).items.find(
      (item) => item.name === 'Hidden file response',
    )!;
    expect(
      await prisma.withTenant(owner.tenantId, (tx) =>
        tx.spPlannerAttachment.count({ where: { taskId: task.id, tenantId: owner.tenantId } }),
      ),
    ).toBe(0);
  });
  it('rejects missing required files and cross-project mappings before storage writes', async () => {
    const q = await intake();
    await expect(service.submitForm(viewer, q.form.id, q.answers)).rejects.toThrow('required');
    await expect(
      service.saveResource(owner, q.form.id, {
        version: q.form.version,
        data: {
          fields: (q.form.data as unknown as PlannerFormData).fields.map((field) => ({
            ...field,
            ...(field.taskField === 'custom' ? { customFieldId: randomUUID() } : {}),
          })),
        },
      }),
    ).rejects.toThrow('unavailable');
    expect(send).not.toHaveBeenCalled();
    await noCreatedTask(q.answers[q.titleId] as string);
  });
  it.each(['version', 'grant', 'project-field', 'capability'] as const)(
    'rechecks %s changes after upload and rolls back every uncommitted file',
    async (change) => {
      const q = await intake();
      let form: PlannerResource = q.form;
      let token = '';
      if (change === 'capability') {
        token = (await service.shareForm(owner, form.id, { version: form.version, enabled: true }))
          .token!;
        form = { ...form, version: form.version + 1 };
      }
      let changed = false;
      send.mockImplementation(async (command) => {
        if (command instanceof PutObjectCommand && !changed) {
          changed = true;
          if (change === 'version')
            await service.saveResource(owner, form.id, {
              version: form.version,
              data: { confirmationMessage: 'Changed during upload' },
            });
          if (change === 'grant')
            await service.saveProject(owner, q.project.id, {
              version: q.project.version,
              data: { members: [] },
            });
          if (change === 'project-field')
            await service.saveProject(owner, q.project.id, {
              version: q.project.version,
              data: { fields: [] },
            });
          if (change === 'capability')
            await service.shareForm(owner, form.id, { version: form.version, enabled: false });
        }
        return {};
      });
      await expect(
        change === 'capability'
          ? service.submitPublicForm(token, q.answers, [q.file])
          : service.submitForm(viewer, form.id, q.answers, [q.file]),
      ).rejects.toThrow();
      const puts = send.mock.calls
        .filter(([command]) => command instanceof PutObjectCommand)
        .map(([command]) => command.input.Key);
      const deletes = send.mock.calls
        .filter(([command]) => command instanceof DeleteObjectCommand)
        .map(([command]) => command.input.Key);
      expect(puts).toHaveLength(1);
      expect(deletes).toEqual(puts);
      await noCreatedTask(q.answers[q.titleId] as string);
    },
  );
  it('revokes an existing capability when access becomes signed-in and allows closing stale mappings', async () => {
    const q = await intake();
    const token = (
      await service.shareForm(owner, q.form.id, { version: q.form.version, enabled: true })
    ).token!;
    const updated = await service.saveResource(owner, q.form.id, {
      version: q.form.version + 1,
      data: { audience: 'organization' },
    });
    await expect(service.publicForm(token)).rejects.toMatchObject({ status: 404 });
    await expect(
      service.shareForm(owner, updated.id, { version: updated.version, enabled: true }),
    ).rejects.toThrow('Anyone with the link');
    await service.saveProject(owner, q.project.id, {
      version: q.project.version,
      data: { fields: [] },
    });
    await service.saveResource(owner, updated.id, { version: updated.version, archived: true });
  });
});
