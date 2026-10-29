/**
 * Mounted-route proof for the engagement attachment history slice: the existing
 * `GET /api/engagement/attachments` route carries history mode, and its list mode
 * is unchanged. The route surface, guards and manifest entry are deliberately the
 * same as before, so no route manifest or registry change is involved.
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { EngagementController } from '../engagement.controller.js';
import { EngagementService } from '../engagement.service.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-history-http',
  role: 'standard_user',
};
const route = '/api/engagement/attachments';
const anchor = id(10);
let app: INestApplication;
let context: unknown;
const service = {
  listAttachments: jest.fn(async () => [{ id: anchor }]),
  listAttachmentHistory: jest.fn(async () => ({ attachmentId: anchor, versions: [] })),
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

test('history mode forwards the exact anchor, cursor and page size', async () => {
  const cursor = 'synthetic-cursor';
  const response = await request(app.getHttpServer())
    .get(`${route}?historyOf=${anchor}&historyCursor=${cursor}&historyPageSize=5`)
    .expect(200);
  expect(response.headers['cache-control'] ?? null).not.toBeUndefined();
  expect(service.listAttachmentHistory).toHaveBeenCalledWith(ctx, {
    attachmentId: anchor,
    cursor,
    pageSize: 5,
  });
  expect(service.listAttachments).not.toHaveBeenCalled();
});

test('history mode requires no list filter and refuses one instead of ignoring it', async () => {
  const response = await request(app.getHttpServer())
    .get(`${route}?historyOf=${anchor}&clientId=${id(7)}`)
    .expect(400);
  expect(JSON.stringify(response.body)).toContain('list filters');
  expect(service.listAttachmentHistory).not.toHaveBeenCalled();
  expect(service.listAttachments).not.toHaveBeenCalled();
});

test('the existing list mode is unchanged', async () => {
  await request(app.getHttpServer())
    .get(`${route}?clientId=${id(7)}&unlinked=true`)
    .expect(200);
  expect(service.listAttachments).toHaveBeenCalledWith(ctx, {
    prospectId: undefined,
    clientId: id(7),
    meetingId: undefined,
    mailMessageId: undefined,
    unlinked: true,
  });
  expect(service.listAttachmentHistory).not.toHaveBeenCalled();
});

test('a malformed anchor is refused before any dispatch', async () => {
  await request(app.getHttpServer()).get(`${route}?historyOf=not-a-uuid`).expect(400);
  expect(service.listAttachmentHistory).not.toHaveBeenCalled();
  expect(service.listAttachments).not.toHaveBeenCalled();
});

test('the existing role guard denies untrusted context before dispatch', async () => {
  context = { ...ctx, role: 'unknown' };
  await request(app.getHttpServer()).get(`${route}?historyOf=${anchor}`).expect(403);
  expect(service.listAttachmentHistory).not.toHaveBeenCalled();
});
