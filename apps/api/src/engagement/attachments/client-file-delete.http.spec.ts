import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EngagementController } from '../engagement.controller.js';
import { EngagementService } from '../engagement.service.js';
import { parseClientFileDelete, fileDeleteUuid } from './client-file-delete.input.js';
import { deleteClientFile, readClientFileDelete } from './client-file-delete.js';
import { ENGAGEMENT_RUNTIME_ACTION_KEY } from '../runtime/engagement-runtime-action.decorator.js';

jest.mock('./client-file-delete.js', () => ({
  deleteClientFile: jest.fn(),
  readClientFileDelete: jest.fn(),
  assertFileKeyNotDeleted: jest.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-delete-http',
  role: 'standard_user',
};
const attachmentId = id(3),
  command = { schemaVersion: 1, requestId: id(4), clientId: id(5), expectedRevision: 2 };
const route = `/api/engagement/attachments/${attachmentId}`;
let app: INestApplication, context: unknown;
const tx = { engagementAttachment: { findFirst: jest.fn() }, $queryRaw: jest.fn() };
const service = {
  prisma: {
    withTenant: jest.fn(async (_tenant: string, callback: (tx: any) => unknown) => callback(tx)),
  },
  s3: {},
  bucket: 'synthetic-bucket',
  clientKb: { purgeAttachmentChunks: jest.fn() },
  lockMeetingClientAssignment: jest.fn(),
  ensureOwnMeeting: jest.fn(),
  ensureOwnMailMessage: jest.fn(),
  deleteAttachment: jest.fn(),
  deleteReviewedAttachment: EngagementService.prototype.deleteReviewedAttachment,
  readAttachmentDeletion: EngagementService.prototype.readAttachmentDeletion,
};
beforeAll(async () => {
  const tokens = Reflect.getMetadata('design:paramtypes', EngagementController) as any[];
  const module = await Test.createTestingModule({
    controllers: [EngagementController],
    providers: tokens.map((token) => ({
      provide: token,
      useValue: token === EngagementService ? service : {},
    })),
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.use((req: any, _res: any, next: () => void) => {
    req.tenantContext = context;
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  jest.resetAllMocks();
  context = ctx;
  service.prisma.withTenant.mockImplementation(async (_tenant, callback) => callback(tx));
  tx.engagementAttachment.findFirst.mockResolvedValue({
    clientId: command.clientId,
    prospectId: null,
  });
  service.deleteAttachment.mockResolvedValue({ ok: true });
  service.ensureOwnMeeting.mockResolvedValue({ id: id(7), clientId: command.clientId });
  jest.mocked(deleteClientFile).mockImplementation(
    async (_owner, _ctx, fileId, raw) =>
      ({
        status: 'completed',
        requestId: parseClientFileDelete(fileId, raw).requestId,
      }) as any,
  );
  jest.mocked(readClientFileDelete).mockImplementation(
    async (_owner, _ctx, requestId) =>
      ({
        status: 'pending',
        requestId: fileDeleteUuid(requestId),
        result: null,
      }) as any,
  );
});
test('mounted DELETE keeps reviewed body, exact route ID, trusted actor, runtime write action and no-store', async () => {
  expect(
    Reflect.getMetadata(
      ENGAGEMENT_RUNTIME_ACTION_KEY,
      EngagementController.prototype.deleteAttachment,
    ),
  ).toMatchObject({ action: 'attachment_external_write' });
  const result = await request(app.getHttpServer()).delete(route).send(command).expect(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(deleteClientFile).toHaveBeenCalledWith(
    expect.objectContaining({ bucket: 'synthetic-bucket', prisma: service.prisma }),
    ctx,
    attachmentId,
    command,
  );
  expect(service.deleteAttachment).not.toHaveBeenCalled();
});
test('mounted GET preserves pending receipt and exact request identity', async () => {
  const result = await request(app.getHttpServer())
    .get(`/api/engagement/attachments/deletions/${command.requestId}`)
    .expect(200);
  expect(result.headers['cache-control']).toBe('private, no-store');
  expect(result.body).toEqual({ status: 'pending', requestId: command.requestId, result: null });
  expect(readClientFileDelete).toHaveBeenCalledWith(
    { prisma: service.prisma },
    ctx,
    command.requestId,
  );
});
test.each([undefined, { ...ctx, role: 'unknown' }])(
  'role guard rejects untrusted current context',
  async (bad) => {
    context = bad;
    await request(app.getHttpServer()).delete(route).send(command).expect(403);
    expect(deleteClientFile).not.toHaveBeenCalled();
  },
);
test.each([undefined, {}])(
  'client deletion without reviewed command cannot reach legacy erasure',
  async (raw) => {
    await request(app.getHttpServer()).delete(route).send(raw).expect(400);
    expect(deleteClientFile).not.toHaveBeenCalled();
    expect(service.deleteAttachment).not.toHaveBeenCalled();
  },
);
test.each([
  { ...command, key: 'untrusted' },
  { ...command, expectedRevision: -1 },
  { ...command, attachmentId: id(9) },
])('malformed command never falls back to legacy erasure', async (raw) => {
  await request(app.getHttpServer()).delete(route).send(raw).expect(400);
  expect(service.deleteAttachment).not.toHaveBeenCalled();
});
test.each([
  { clientId: null, prospectId: id(6) },
  { clientId: null, prospectId: null },
])('existing prospect/nonclient deletion keeps its established owner', async (row) => {
  tx.engagementAttachment.findFirst.mockResolvedValue(row);
  await request(app.getHttpServer()).delete(route).expect(200);
    expect(service.deleteAttachment).toHaveBeenCalledWith(ctx, attachmentId, true);
  expect(deleteClientFile).not.toHaveBeenCalled();
});
test('storage/index callbacks reuse existing owners and require current meeting-client agreement', async () => {
  await request(app.getHttpServer()).delete(route).send(command).expect(200);
  const owner = jest.mocked(deleteClientFile).mock.calls[0]![0];
  await owner.purgeChunks(tx as any, ctx.tenantId, attachmentId);
  expect(service.clientKb.purgeAttachmentChunks).toHaveBeenCalledWith(
    tx,
    ctx.tenantId,
    attachmentId,
  );
  const row = { meetingId: id(7), clientId: command.clientId, mailMessageId: null } as any;
  await owner.parents(tx as any, ctx as any, row);
  expect(service.lockMeetingClientAssignment).toHaveBeenCalledWith(tx, ctx, id(7));
  expect(service.ensureOwnMeeting).toHaveBeenCalledWith(tx, ctx, id(7));
  service.ensureOwnMeeting.mockResolvedValue({ id: id(7), clientId: id(8) });
  await expect(owner.parents(tx as any, ctx as any, row)).rejects.toMatchObject({ status: 409 });
});
test('mail-parent ownership is checked by the existing service predicate in the locked transaction', async () => {
  await request(app.getHttpServer()).delete(route).send(command).expect(200);
  const owner = jest.mocked(deleteClientFile).mock.calls[0]![0];
  await owner.parents(tx as any, ctx as any, { meetingId: null, mailMessageId: id(8) } as any);
  expect(service.ensureOwnMailMessage).toHaveBeenCalledWith(tx, ctx, id(8));
});
