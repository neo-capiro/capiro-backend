import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ClientBriefCopyController } from './client-brief-copy.controller.js';
import { TenantGuard } from '../auth/tenant.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DraftsService } from '../drafts/drafts.service.js';
import { copyBriefToClient, readClientBriefCopy } from './client-brief-copy.js';

jest.mock('./client-brief-copy.js', () => ({
  copyBriefToClient: jest.fn(),
  readClientBriefCopy: jest.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenantId = id(1),
  actor = 'synthetic-brief-http',
  prospectId = id(2),
  clientId = id(3),
  requestId = id(4);
const route = `/workspace-api/prospects/${prospectId}/clients/${clientId}/brief-copies`;
const prisma = {},
  drafts = {},
  body = { schemaVersion: 1, requestId, prospectId, clientId, docTitle: 'Reviewed' };
let app: INestApplication, allowed: boolean;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ClientBriefCopyController],
    providers: [
      { provide: PrismaService, useValue: prisma },
      { provide: DraftsService, useValue: drafts },
    ],
  })
    .overrideGuard(TenantGuard)
    .useValue({
      canActivate: (context: any) => {
        context.switchToHttp().getRequest().tenantContext = { tenantId, clerkUserId: actor };
        return allowed;
      },
    })
    .compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('workspace-api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  allowed = true;
  jest.resetAllMocks();
  jest
    .mocked(copyBriefToClient)
    .mockResolvedValue({ status: 'completed', available: true } as never);
  jest
    .mocked(readClientBriefCopy)
    .mockResolvedValue({ status: 'completed', available: false } as never);
});
test('mounted client-copy POST passes frozen command and trusted tenant/actor to existing owners', async () => {
  const response = await request(app.getHttpServer()).post(route).send(body).expect(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(copyBriefToClient).toHaveBeenCalledWith(
    prisma,
    drafts,
    tenantId,
    actor,
    prospectId,
    clientId,
    body,
  );
});
test('historical receipt GET binds both source prospect and target client, including deleted drafts', async () => {
  const response = await request(app.getHttpServer()).get(`${route}/${requestId}`).expect(200);
  expect(response.headers['cache-control']).toBe('private, no-store');
  expect(response.body.available).toBe(false);
  expect(readClientBriefCopy).toHaveBeenCalledWith(
    prisma,
    tenantId,
    actor,
    prospectId,
    clientId,
    requestId,
  );
});
test('the registered tenant guard denies dispatch', async () => {
  allowed = false;
  await request(app.getHttpServer()).post(route).send(body).expect(403);
  expect(copyBriefToClient).not.toHaveBeenCalled();
});
test('actual command parser rejects malformed mounted requests before a transaction', async () => {
  const actual =
    jest.requireActual<typeof import('./client-brief-copy.js')>('./client-brief-copy.js');
  jest.mocked(copyBriefToClient).mockImplementation(actual.copyBriefToClient);
  await request(app.getHttpServer()).post(route).send(body).expect(400);
});
