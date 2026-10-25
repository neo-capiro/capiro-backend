import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EngagementController } from '../engagement.controller.js';
import { EngagementService } from '../engagement.service.js';
import { parseProspectFileCopy } from './prospect-file-copy.input.js';
import { ENGAGEMENT_RUNTIME_ACTION_KEY } from '../runtime/engagement-runtime-action.decorator.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-copy-http',
  role: 'standard_user',
};
const input = {
  schemaVersion: 1,
  requestId: id(3),
  prospectId: id(4),
  clientId: id(5),
  sourceId: id(6),
  expectedProspectUpdatedAt: '2026-10-25T00:00:00.000Z',
  expectedRevision: 0,
  checksumSha256: 'a'.repeat(64),
  contentLength: 12,
  folder: null,
};
const route = '/api/engagement/attachments/prospect-copies';
let app: INestApplication, context: unknown;
const service = {
  copyProspectAttachment: jest.fn(async (_ctx: unknown, raw: unknown) => ({
    status: 'completed',
    requestId: parseProspectFileCopy(raw).requestId,
  })),
  readProspectAttachmentCopy: jest.fn(async () => ({ status: 'pending', result: null })),
};
beforeAll(async () => {
  const tokens = Reflect.getMetadata('design:paramtypes', EngagementController) as unknown[];
  const module = await Test.createTestingModule({
    controllers: [EngagementController],
    providers: tokens.map((token: any) => ({
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
  context = ctx;
  jest.clearAllMocks();
});
test('mounted copy route retains complete reviewed body and trusted current context', async () => {
  expect(
    Reflect.getMetadata(
      ENGAGEMENT_RUNTIME_ACTION_KEY,
      EngagementController.prototype.copyProspectAttachment,
    ),
  ).toMatchObject({ action: 'attachment_external_write' });
  const response = await request(app.getHttpServer()).post(route).send(input).expect(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(service.copyProspectAttachment).toHaveBeenCalledWith(ctx, input);
});
test('mounted history route preserves pending status and binds the request ID', async () => {
  const response = await request(app.getHttpServer())
    .get(`${route}/${input.requestId}`)
    .expect(200);
  expect(response.body).toEqual({ status: 'pending', result: null });
  expect(service.readProspectAttachmentCopy).toHaveBeenCalledWith(ctx, input.requestId);
});
test.each([undefined, { ...ctx, role: 'unknown' }])(
  'existing role guard denies untrusted context before dispatch',
  async (bad) => {
    context = bad;
    await request(app.getHttpServer()).post(route).send(input).expect(403);
    expect(service.copyProspectAttachment).not.toHaveBeenCalled();
  },
);
test('actual parser refuses untrusted storage fields through mounted POST', async () => {
  await request(app.getHttpServer())
    .post(route)
    .send({ ...input, objectKey: 'untrusted' })
    .expect(400);
});
