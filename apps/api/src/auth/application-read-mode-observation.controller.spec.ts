import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ApplicationReadModeObservationController } from './application-read-mode-observation.controller.js';
import { ApplicationReadModeObservationService } from './application-read-mode-observation.service.js';
import { ApplicationMembershipService } from './application-membership.service.js';
import { ToolServiceSecretGuard } from '../meri/tool-service-secret.guard.js';
import { RolesGuard } from './roles.guard.js';

const tenantId = '11111111-1111-4111-8111-111111111111', actorId = '22222222-2222-4222-8222-222222222222';
const input = { operation: { id: 'search_federal_awards', version: '0.2.0' }, requestSha256: 'b'.repeat(64) };
const SECRET = 'mode-controller-synthetic-secret';
describe('served native mode projection', () => {
  let app: INestApplication;
  let role = 'standard_user';
  const member = { read: jest.fn(async () => ({ tenantId, actorId, status: 'active' })) };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [ApplicationReadModeObservationController], providers: [
      ApplicationReadModeObservationService, ToolServiceSecretGuard, RolesGuard,
      { provide: ApplicationMembershipService, useValue: member },
      { provide: ConfigService, useValue: { get: (key: string) => key === 'NODE_ENV' ? 'development' : key === 'INTERNAL_SERVICE_SECRET' ? SECRET : false } },
    ] }).compile();
    app = module.createNestApplication(); app.setGlobalPrefix('api');
    // Only authentication I/O is replaced; actual controller, role/service guards and service execute.
    app.use((req: any, _res: unknown, next: () => void) => { req.tenantContext = { tenantId, userId: actorId, role }; next(); });
    await app.init();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { member.read.mockClear(); role = 'standard_user'; });
  const post = (body: Record<string, unknown> = input, secret?: string) => {
    const pending = request(app.getHttpServer()).post('/api/clio/application-authority/read-mode-observation');
    if (secret !== undefined) pending.set('x-internal-service-secret', secret);
    return pending.send(body);
  };

  it('serves the exact closed response with no-store under the original operation/hash', async () => {
    const response = await post(input, SECRET).expect(200);
    expect(response.body).toEqual({ ...input, principal: { tenantId, actorId }, surface: 'chat', evidenceAccuracyMode: expect.stringMatching(/^(off|shadow|enforce)$/) });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(member.read).toHaveBeenCalledTimes(1);
  });
  it('refuses observe-only service admission, malformed input and wrong native role before current-owner I/O', async () => {
    await post(input).expect(403); await post(input, 'wrong').expect(403);
    await post({ ...input, principal: { tenantId, actorId } }, SECRET).expect(400);
    role = 'unknown'; await post(input, SECRET).expect(403);
    expect(member.read).not.toHaveBeenCalled();
  });
});

it('cancels an unsettled current owner and removes request-local listeners', async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const req: any = Object.assign(new EventEmitter(), { headers: {}, aborted: false });
  const res: any = Object.assign(new EventEmitter(), { destroyed: false, writableFinished: false });
  const observation = { read: async () => { req.emit('aborted'); await pending; return {}; } };
  const controller = new ApplicationReadModeObservationController(observation as never);
  try {
    await expect(controller.readModeObservation({} as never, req, res, input)).rejects.toThrow('no longer active');
    expect(req.listenerCount('aborted')).toBe(0); expect(res.listenerCount('close')).toBe(0);
  } finally { release(); await new Promise<void>(resolve => setImmediate(resolve)); }
});
