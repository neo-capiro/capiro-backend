import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { OutreachSessionService } from '../services/outreach-session.service.js';
import { OutreachCommandEngineService } from '../services/outreach-command-engine.service.js';
import { OutreachCommandProposalService } from '../services/outreach-command-proposal.service.js';
import { OutreachV3StateController } from './outreach-v3-state.controller.js';
import { OutreachV3StateGuard } from './outreach-v3-state.guard.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'user_synthetic',
  role: 'standard_user',
};
const sessionId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const objectiveId = '55555555-5555-4555-8555-555555555555';
const path = `/engagement/outreach-v3/sessions/${sessionId}/objective-destination`;
const query = { clientId, objectiveId, objectiveVersion: 2 };

describe('Objective-bound Outreach HTTP contract (synthetic authentication)', () => {
  let app: INestApplication;
  let enabled = true;
  const sessions = {
    getObjectiveDestination: jest.fn().mockResolvedValue({
      destination: {
        kind: 'outreach_session',
        resourceId: sessionId,
        clientId,
        objectiveId,
        objectiveVersion: 2,
        objectiveRevisionId: '66666666-6666-4666-8666-666666666666',
        destinationStateVersion: 4,
      },
    }),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [OutreachV3StateController],
      providers: [
        { provide: OutreachSessionService, useValue: sessions },
        { provide: OutreachCommandEngineService, useValue: {} },
        { provide: OutreachCommandProposalService, useValue: {} },
      ],
    })
      .overrideGuard(OutreachV3StateGuard)
      .useValue({ canActivate: () => enabled })
      .compile();
    app = module.createNestApplication();
    app.use(
      (
        req: Request & { tenantContext?: TenantContext },
        _response: Response,
        next: NextFunction,
      ) => {
        if (req.headers['x-test-actor'] === 'standard') req.tenantContext = ctx;
        if (req.headers['x-test-actor'] === 'portal')
          req.tenantContext = { ...ctx, role: 'client_portal_user' };
        next();
      },
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    jest.clearAllMocks();
    enabled = true;
  });

  it('validates the exact revision query and returns a private uncacheable owner response', async () => {
    const result = await request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('x-test-actor', 'standard')
      .expect(200);
    expect(result.headers['cache-control']).toBe('private, no-store');
    expect(sessions.getObjectiveDestination).toHaveBeenCalledWith(ctx, sessionId, query);
    expect(result.body.destination.kind).toBe('outreach_session');
  });

  it('refuses missing/portal context and honors the existing feature guard before resolution', async () => {
    await request(app.getHttpServer()).get(path).query(query).expect(403);
    await request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('x-test-actor', 'portal')
      .expect(403);
    enabled = false;
    await request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('x-test-actor', 'standard')
      .expect(403);
    expect(sessions.getObjectiveDestination).not.toHaveBeenCalled();
  });

  it.each(['clientId', 'objectiveId', 'objectiveVersion'])('refuses missing %s', async (field) => {
    const partial = { ...query } as Record<string, unknown>;
    delete partial[field];
    await request(app.getHttpServer())
      .get(path)
      .query(partial)
      .set('x-test-actor', 'standard')
      .expect(400);
    expect(sessions.getObjectiveDestination).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '1.5', 'Infinity', '2147483648', 'oops', ''])(
    'refuses objectiveVersion %s',
    async (objectiveVersion) => {
      await request(app.getHttpServer())
        .get(path)
        .query({ ...query, objectiveVersion })
        .set('x-test-actor', 'standard')
        .expect(400);
      expect(sessions.getObjectiveDestination).not.toHaveBeenCalled();
    },
  );

  it('refuses arbitrary kind, URLs, actor/tenant and revision claims', async () => {
    for (const extra of [
      { kind: 'workspace' },
      { resourceId: sessionId },
      { url: 'https://foreign.invalid' },
      { userId: ctx.userId },
      { tenantId: ctx.tenantId },
      { objectiveRevisionId: objectiveId },
    ]) {
      await request(app.getHttpServer())
        .get(path)
        .query({ ...query, ...extra })
        .set('x-test-actor', 'standard')
        .expect(400);
    }
    expect(sessions.getObjectiveDestination).not.toHaveBeenCalled();
  });

  it('refuses malformed route and canonical IDs', async () => {
    await request(app.getHttpServer())
      .get(path.replace(sessionId, 'bad'))
      .query(query)
      .set('x-test-actor', 'standard')
      .expect(400);
    await request(app.getHttpServer())
      .get(path)
      .query({ ...query, clientId: 'bad' })
      .set('x-test-actor', 'standard')
      .expect(400);
    await request(app.getHttpServer())
      .get(path)
      .query({ ...query, objectiveId: 'bad' })
      .set('x-test-actor', 'standard')
      .expect(400);
    expect(sessions.getObjectiveDestination).not.toHaveBeenCalled();
  });
});
