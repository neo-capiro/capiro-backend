import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { ObjectiveOperationalController } from './objective-operational.controller.js';
import { ObjectiveOperationalGuard } from './objective-operational.guard.js';
import { ObjectiveOperationalService } from './objective-operational.service.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const client = id(3),
  objective = id(4),
  requestId = id(5);
const command = {
  schemaVersion: 1,
  requestId,
  clientId: client,
  objectiveId: objective,
  expectedObjectiveVersion: 2,
  expectedAssociationSetVersion: 0,
  action: 'link',
  resource: { kind: 'strategy', id: id(6) },
  cycles: [],
};
/** Transport/guard fixtures only. Real current authority and SQL are separate suites. */
describe('Objective operational closed HTTP boundary', () => {
  let app: INestApplication;
  const service = { read: jest.fn(), command: jest.fn(), receipt: jest.fn() };
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ObjectiveOperationalController],
      providers: [
        ObjectiveOperationalGuard,
        { provide: ObjectiveOperationalService, useValue: service },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use((req: any, _res: any, next: () => void) => {
      if (req.headers['x-fixture-user'])
        req.tenantContext = {
          tenantId: id(1),
          userId: id(2),
          clerkUserId: 'fixture_subject',
          tenantSlug: 'fixture',
          role: req.headers['x-fixture-role'] ?? 'standard_user',
        };
      next();
    });
    await app.init();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    service.read.mockResolvedValue({ read: true });
    service.command.mockResolvedValue({ receipt: true });
    service.receipt.mockResolvedValue({ historical: true });
  });
  afterAll(async () => {
    await app.close();
  });
  const path = `/clients/${client}/objectives`;
  test('exact registered routes decode strict fixed inputs and return 200 private no-store', async () => {
    const post = await request(app.getHttpServer())
      .post(`${path}/operational-associations`)
      .set('x-fixture-user', 'yes')
      .send(command)
      .expect(200);
    expect(post.headers['cache-control']).toBe('private, no-store');
    expect(service.command.mock.calls[0]![1]).toEqual(command);
    const get = await request(app.getHttpServer())
      .get(`${path}/operational?schemaVersion=1&objectiveId=${objective}&limit=20`)
      .set('x-fixture-user', 'yes')
      .expect(200);
    expect(get.headers['cache-control']).toBe('private, no-store');
    expect(service.read.mock.calls[0]![1]).toEqual({
      schemaVersion: 1,
      clientId: client,
      objectiveId: objective,
      limit: 20,
      cursors: { strategies: null, projects: null, decisions: null, engagements: null },
    });
    await request(app.getHttpServer())
      .get(`${path}/operational-associations/${requestId}?schemaVersion=1&objectiveId=${objective}`)
      .set('x-fixture-user', 'yes')
      .expect(200);
    expect(service.receipt.mock.calls[0]![1]).toEqual({
      schemaVersion: 1,
      clientId: client,
      objectiveId: objective,
      requestId,
    });
  });
  test('missing identity and unsupported impersonation refuse before delegation with closed safe errors', async () => {
    const noActor = await request(app.getHttpServer())
      .post(`${path}/operational-associations`)
      .send(command)
      .expect(401);
    expect(noActor.body).toEqual({
      schemaVersion: 1,
      requestId: null,
      status: 401,
      code: 'UNAUTHENTICATED',
      outcome: 'rejected',
    });
    expect(noActor.headers['cache-control']).toBe('private, no-store');
    const impersonated = await request(app.getHttpServer())
      .post(`${path}/operational-associations`)
      .set('x-fixture-user', 'yes')
      .set('x-capiro-impersonate-tenant', id(99))
      .send(command)
      .expect(403);
    expect(impersonated.body.code).toBe('FORBIDDEN');
    expect(service.command).not.toHaveBeenCalled();
  });
  test.each(['reader', 'unexpected'])('role %s cannot use a standard-user route', async (role) => {
    await request(app.getHttpServer())
      .post(`${path}/operational-associations`)
      .set('x-fixture-user', 'yes')
      .set('x-fixture-role', role)
      .send(command)
      .expect(403);
    expect(service.command).not.toHaveBeenCalled();
  });
  test.each([
    { ...command, tenantId: id(99) },
    { ...command, actorUserId: id(99) },
    { ...command, clientId: id(99) },
    { ...command, resource: { ...command.resource, ownerVersion: 1 } },
    { ...command, expectedObjectiveVersion: '2' },
  ])('rejects forged/unknown request fields without delegation', async (body) => {
    const result = await request(app.getHttpServer())
      .post(`${path}/operational-associations`)
      .set('x-fixture-user', 'yes')
      .send(body)
      .expect(400);
    expect(result.body).toMatchObject({
      schemaVersion: 1,
      status: 400,
      code: 'MALFORMED_REQUEST',
      outcome: 'rejected',
    });
    expect(service.command).not.toHaveBeenCalled();
  });
  test.each([
    `schemaVersion=1&schemaVersion=1&objectiveId=${objective}&limit=20`,
    `schemaVersion=1&objectiveId=${objective}&limit=20&tenantId=${id(99)}`,
    `schemaVersion=1&objectiveId=${objective}&limit=020`,
  ])('rejects ambiguous/unknown GET query %s', async (query) => {
    await request(app.getHttpServer())
      .get(`${path}/operational?${query}`)
      .set('x-fixture-user', 'yes')
      .expect(400);
    expect(service.read).not.toHaveBeenCalled();
  });
});
