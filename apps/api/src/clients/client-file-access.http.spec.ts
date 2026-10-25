import { afterAll, beforeAll, beforeEach, expect, jest, test } from '@jest/globals';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { ClientFilesController, ClientFilesService } from './client-files.controller.js';
import { commitFileAccess, getFileAccessReceipt } from './client-file-access-command.js';
import { lockFileAccessRows } from './client-file-access-authority.js';

jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./client-file-access-command.js', () => ({
  commitFileAccess: jest.fn(),
  getFileAccessReceipt: jest.fn(),
  FILE_ACCESS_TRANSACTION_TIMEOUT_MS: 60_000,
}));
jest.mock('./client-file-access-authority.js', () => ({ lockFileAccessRows: jest.fn() }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = {
  tenantId: id(1),
  userId: id(2),
  clerkUserId: 'synthetic-file-actor',
  role: 'standard_user',
} as TenantContext;
const base = `/api/clients/${id(3)}/files`;
const command = {
  schemaVersion: 1,
  requestId: id(4),
  clientId: id(3),
  operation: 'file-access',
  folder: null,
  files: [{ id: id(5), expectedRevision: 7 }],
  viewerMode: 'all',
  viewerUserIds: [],
};
let app: INestApplication;
beforeAll(async () => {
  const service = new ClientFilesService({
    withTenant: async (_tenant: string, run: (tx: unknown) => unknown) => run({}),
  } as never);
  const module = await Test.createTestingModule({
    controllers: [ClientFilesController],
    providers: [{ provide: ClientFilesService, useValue: service }],
  }).compile();
  app = module.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
    req.tenantContext = ctx;
    next();
  });
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(commitFileAccess).mockResolvedValue({ status: 'completed' } as never);
  jest.mocked(getFileAccessReceipt).mockResolvedValue({ status: 'refused' } as never);
});

test('single-file route dispatches the strict reviewed command and disables caching', async () => {
  const response = await request(app.getHttpServer())
    .patch(`${base}/${id(5)}/access`)
    .send(command)
    .expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(jest.mocked(commitFileAccess).mock.calls[0]!.slice(1)).toEqual([ctx, id(3), command]);
});
test.each([
  [`${base}/${id(6)}/access`, command],
  [`${base}/${id(5)}/access`, { ...command, operation: 'folder-access' }],
  [`${base}/access/folder`, command],
  [`${base}/${id(5)}/access`, { viewerMode: 'all', viewerUserIds: [] }],
  [`${base}/${id(5)}/access`, { ...command, extra: true }],
])('route/payload mismatch is rejected before the writer %#', async (path, body) => {
  await request(app.getHttpServer()).patch(path).send(body).expect(400);
  expect(commitFileAccess).not.toHaveBeenCalled();
});
test('folder route preserves the reviewed write set', async () => {
  const body = { ...command, operation: 'folder-access' };
  await request(app.getHttpServer()).patch(`${base}/access/folder`).send(body).expect(200);
  expect(jest.mocked(commitFileAccess).mock.calls[0]![3]).toEqual(body);
});
test('receipt lookup stays under the client and never caches terminal refusals', async () => {
  const response = await request(app.getHttpServer())
    .get(`${base}/access/commands/${id(4)}`)
    .expect(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(jest.mocked(getFileAccessReceipt).mock.calls[0]!.slice(1)).toEqual([ctx, id(3), id(4)]);
});
test('access review returns metadata revision and omits internal provenance', async () => {
  jest.mocked(lockFileAccessRows).mockResolvedValue([
    {
      id: id(5),
      fileName: 'Synthetic.txt',
      folder: null,
      metadataRevision: 7,
      viewerMode: 'all',
      viewerUserIds: [],
      uploadedByUserId: null,
      sourceEntityType: 'synthetic-source',
      sourceEntityId: 'synthetic',
      lifecycleStatus: 'ready',
    },
  ]);
  const response = await request(app.getHttpServer())
    .get(`${base}/${id(5)}/access`)
    .expect(200);
  expect(response.body).toEqual({
    id: id(5),
    fileName: 'Synthetic.txt',
    folder: null,
    metadataRevision: 7,
    viewerMode: 'all',
    viewerUserIds: [],
    uploadedByUserId: null,
  });
  expect(response.headers['cache-control']).toBe('no-store');
});
test('malformed file read is rejected before raw UUID SQL', async () => {
  await request(app.getHttpServer()).get(`${base}/not-a-uuid/access`).expect(400);
  expect(lockFileAccessRows).not.toHaveBeenCalled();
});
test('removed single-file move writer is unavailable; PF16 owns moves', async () => {
  await request(app.getHttpServer())
    .patch(`${base}/${id(5)}/folder`)
    .send({ folder: null })
    .expect(404);
});
