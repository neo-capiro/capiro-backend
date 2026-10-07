import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { PlannerAttachmentsService, plannerAttachmentName } from './planner-attachments.service.js';
import { PLANNER_DEFAULT_PROJECT, PLANNER_DEFAULT_TASK } from '@capiro/strategy-verifier';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
const TENANT = '10000000-0000-4000-8000-000000000001',
  TASK = '30000000-0000-4000-8000-000000000001',
  PROJECT = '20000000-0000-4000-8000-000000000001',
  FILE = '80000000-0000-4000-8000-000000000001';
const ctx: AuthTenantContext = { tenantId: TENANT, clerkUserId: 'user_editor', role: 'org:member' };
function fixture(role: 'editor' | 'commenter' | 'viewer' = 'editor') {
  const project = {
    id: PROJECT,
    ownerId: 'user_owner',
    data: {
      ...PLANNER_DEFAULT_PROJECT,
      name: 'Private',
      members: [{ userId: ctx.clerkUserId, role }],
    },
  };
  const task = {
    id: TASK,
    tenantId: TENANT,
    ownerId: 'user_owner',
    archived: false,
    data: {
      ...PLANNER_DEFAULT_TASK,
      name: 'Private task',
      memberships: [{ projectId: PROJECT, sectionId: null, position: 0 }],
    },
  };
  const file = {
    id: FILE,
    tenantId: TENANT,
    taskId: TASK,
    uploadedBy: 'user_owner',
    fileName: 'notes.txt',
    sizeBytes: 5,
    objectKey: `tenants/${TENANT}/planner/tasks/${TASK}/${FILE}`,
    archived: false,
    createdAt: new Date(),
  };
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    spPlannerProject: { findMany: jest.fn(async () => [project]) },
    spPlannerTask: {
      findFirst: jest.fn(async ({ where }) =>
        where.tenantId === TENANT && where.id === TASK ? task : null,
      ),
    },
    spPlannerAttachment: {
      findMany: jest.fn(async () => [file]),
      findFirst: jest.fn(async () => file),
      create: jest.fn(async ({ data }) => ({ ...file, ...data })),
      update: jest.fn(async ({ data }) => ({ ...file, ...data })),
    },
    spPlannerEvent: { create: jest.fn(async () => ({ id: FILE })) },
    spPlannerInbox: { create: jest.fn(async () => ({})) },
  };
  const prisma = {
    withTenant: jest.fn(async (tenantId, run) => {
      expect(tenantId).toBe(TENANT);
      return run(tx);
    }),
  };
  return {
    service: new PlannerAttachmentsService(prisma as unknown as PrismaService),
    tx,
    project,
    task,
    file,
  };
}
describe('Planner file authorization and storage', () => {
  let send: jest.SpyInstance;
  const priorBucket = process.env.ASSETS_BUCKET;
  beforeEach(() => {
    process.env.ASSETS_BUCKET = 'synthetic-planner-qa';
    send = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({} as never);
  });
  afterEach(() => {
    send.mockRestore();
    if (priorBucket === undefined) delete process.env.ASSETS_BUCKET;
    else process.env.ASSETS_BUCKET = priorBucket;
  });
  it.each(['../secret', 'folder/file', 'folder\\file', 'bad\nname', ''])(
    'rejects unsafe filename %s',
    (name) => expect(() => plannerAttachmentName(name)).toThrow(),
  );
  it('rejects missing, empty and oversized files before accessing S3', async () => {
    const f = fixture();
    await expect(f.service.upload(ctx, TASK, undefined)).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.upload(ctx, TASK, { originalname: 'empty', buffer: Buffer.alloc(0), size: 0 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.service.upload(ctx, TASK, {
        originalname: 'big',
        buffer: Buffer.alloc(1),
        size: 26 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(send).not.toHaveBeenCalled();
  });
  it('denies viewer uploads and does not disclose tenant files to an outsider', async () => {
    const f = fixture('viewer');
    await expect(
      f.service.upload(ctx, TASK, {
        originalname: 'ok.txt',
        size: 5,
        buffer: Buffer.from('hello'),
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.service.list({ ...ctx, clerkUserId: 'user_outsider' }, TASK),
    ).rejects.toMatchObject({ status: 404 });
    expect(send).not.toHaveBeenCalled();
  });
  it('uses an immutable tenant/task prefix and hides object keys in responses', async () => {
    const f = fixture();
    const result = await f.service.upload(ctx, TASK, {
      originalname: 'notes.txt',
      size: 5,
      buffer: Buffer.from('hello'),
    });
    const command = send.mock.calls[0]![0] as PutObjectCommand;
    expect(command.input.Key).toMatch(new RegExp(`^tenants/${TENANT}/planner/tasks/${TASK}/`));
    expect(result).not.toHaveProperty('objectKey');
    expect(f.tx.spPlannerInbox.create).toHaveBeenCalled();
  });
  it('rechecks access after upload and cleans up an object if the grant was revoked', async () => {
    const f = fixture('commenter');
    send.mockImplementationOnce(async () => {
      f.project.data.members = [];
      return {};
    });
    await expect(
      f.service.upload(ctx, TASK, {
        originalname: 'notes.txt',
        size: 5,
        buffer: Buffer.from('hello'),
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(send.mock.calls[1]![0]).toBeInstanceOf(DeleteObjectCommand);
    expect(f.tx.spPlannerAttachment.create).not.toHaveBeenCalled();
  });
  it('restricts commenter archiving to their own files and permits recovery', async () => {
    const f = fixture('commenter');
    await expect(f.service.archive(ctx, TASK, FILE, { archived: true })).rejects.toMatchObject({
      status: 403,
    });
    f.file.uploadedBy = ctx.clerkUserId;
    expect((await f.service.archive(ctx, TASK, FILE, { archived: false })).archived).toBe(false);
  });
});
