import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientKbService } from '../../embeddings/client-kb.service.js';
import { ProspectContactsController } from './prospect-contacts.controller.js';
import { ProspectContactsService } from './prospect-contacts.service.js';
import { ProspectContactTransfersService } from './prospect-contact-transfers.service.js';
import { commitContactTransfer, readContactTransfer } from './prospect-contact-transfer-command.js';

jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('./prospect-contact-transfer-command.js', () => ({
  commitContactTransfer: jest.fn(),
  readContactTransfer: jest.fn(),
}));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-transfer-http',
  role: 'standard_user',
} as TenantContext;
const command = {
  schemaVersion: 1,
  requestId: id(3),
  prospectId: id(4),
  clientId: id(5),
  expectedProspectUpdatedAt: '2026-10-25T00:00:00.000Z',
  items: [{ sourceId: id(6), expectedVersion: 1, action: 'skip' }],
};
const base = `/api/business-development/prospects/${command.prospectId}/contacts/transfers`;
let app: INestApplication, context: TenantContext | undefined, enabled: boolean;
const prisma = {
  withTenant: async (_tenant: string, run: (tx: unknown) => unknown) =>
    run({
      tenant: {
        findUnique: async () => ({
          settings: { clioFeatureFlags: { 'businessDevelopment.enabled': enabled } },
        }),
      },
    }),
};
beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ProspectContactsController],
    providers: [
      ProspectContactTransfersService,
      { provide: ProspectContactsService, useValue: {} },
      { provide: PrismaService, useValue: prisma },
      { provide: ClientKbService, useValue: { indexPersonFireAndForget: jest.fn() } },
    ],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
    req.tenantContext = context;
    next();
  });
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  jest.resetAllMocks();
  context = ctx;
  enabled = true;
  jest
    .mocked(commitContactTransfer)
    .mockResolvedValue({ receipt: { status: 'completed' }, createdIds: [] } as never);
  jest.mocked(readContactTransfer).mockResolvedValue({ status: 'refused' } as never);
});
test('registered POST retains the entire explicit manifest and returns a noncached terminal outcome', async () => {
  const response = await request(app.getHttpServer()).post(base).send(command).expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body).toEqual({ status: 'completed' });
  expect(commitContactTransfer).toHaveBeenCalledWith(prisma, ctx, command.prospectId, command);
});
test('registered receipt GET is prospect-scoped and noncached, including durable refusals', async () => {
  const response = await request(app.getHttpServer())
    .get(`${base}/${command.requestId}`)
    .expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.status).toBe('refused');
  expect(readContactTransfer).toHaveBeenCalledWith(
    prisma,
    ctx,
    command.prospectId,
    command.requestId,
  );
});
test.each([undefined, { ...ctx, role: 'client_portal_user' }])(
  'existing role guard denies unavailable actor %#',
  async (actor) => {
    context = actor as TenantContext | undefined;
    await request(app.getHttpServer()).post(base).send(command).expect(403);
    expect(commitContactTransfer).not.toHaveBeenCalled();
  },
);
test('existing feature guard denies the route before transfer dispatch', async () => {
  enabled = false;
  await request(app.getHttpServer()).post(base).send(command).expect(404);
  expect(commitContactTransfer).not.toHaveBeenCalled();
});
test.each([{ extra: true }, { prospectId: id(99) }, { items: [] }])(
  'actual command parser rejects malformed HTTP input %#',
  async (patch) => {
    const actual = jest.requireActual<typeof import('./prospect-contact-transfer-command.js')>(
      './prospect-contact-transfer-command.js',
    );
    jest.mocked(commitContactTransfer).mockImplementation(actual.commitContactTransfer);
    await request(app.getHttpServer())
      .post(base)
      .send({ ...command, ...patch })
      .expect(400);
  },
);
