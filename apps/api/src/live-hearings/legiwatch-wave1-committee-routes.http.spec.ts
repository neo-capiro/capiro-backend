import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { TenantContext } from '@capiro/shared';
import { RolesGuard } from '../auth/roles.guard.js';
import { configureApiHttpApp } from '../bootstrap/configure-api-http-app.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LegiWatchWave1Controller } from './legiwatch-wave1.controller.js';
import { LegiWatchWave1Service } from './legiwatch-wave1.service.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

// The two committees LW-QA-016/017 were reported against, in the casing the
// browser actually sends (congress.gov's own display casing).
const SENATE = 'SSAS00';
const HOUSE = 'HSAS00';

/**
 * HTTP-level proof that the Wave 1 committee routes are MOUNTED and survive the
 * real request pipeline (LW-QA-016 / LW-QA-017).
 *
 * The service-level specs call `wave1.committeeFollowState(...)` directly, so
 * they stay green even if the route never binds, the global ValidationPipe
 * rejects the real query string, or a sibling controller shadows the path. In
 * production all three follow verbs and the intelligence-history route answered
 * 404 while the Committee Room on the same prefix answered 200 — a failure mode
 * no direct-call spec can see.
 *
 * Uses the REAL `configureApiHttpApp()` (global `/api` prefix, whitelisting
 * ValidationPipe, Prisma exception filter) rather than a per-test copy.
 */
describe('LegiWatch Wave 1 committee routes through the real HTTP pipeline', () => {
  let app: INestApplication;

  const committeeFollowState = jest.fn().mockResolvedValue({ following: false });
  const upsertCommitteeFollow = jest.fn().mockResolvedValue({ following: true });
  const unfollowCommittee = jest.fn().mockResolvedValue({ following: false });
  const committeeIntelligenceHistory = jest.fn().mockResolvedValue({ rows: [], total: 0 });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LegiWatchWave1Controller],
      providers: [
        {
          provide: LegiWatchWave1Service,
          useValue: {
            committeeFollowState,
            upsertCommitteeFollow,
            unfollowCommittee,
            committeeIntelligenceHistory,
          },
        },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: PrismaService,
          useValue: {
            committeeHearing: {
              findUnique: async () => null,
            },
          },
        },
      ],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    configureApiHttpApp(app, {
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });
    app.use((req: { tenantContext?: TenantContext }, _res: unknown, next: () => void) => {
      req.tenantContext = {
        tenantId: TENANT,
        tenantSlug: 'test',
        userId: USER,
        clerkUserId: `clerk_${USER}`,
        role: 'standard_user',
      };
      next();
    });
    await app.init();
  });

  afterAll(async () => {
    // Tolerate a failed beforeAll: at runtime app may never have been assigned.
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const base = '/api/legiwatch/live-hearings/committees';

  it.each([SENATE, HOUSE])('GET %s/follow is mounted and reaches the service', async (code) => {
    const res = await request(app.getHttpServer()).get(`${base}/${code}/follow`);
    expect(res.status).toBe(200);
    expect(committeeFollowState).toHaveBeenCalledWith(expect.anything(), code);
  });

  it.each([SENATE, HOUSE])('PUT %s/follow is mounted and reaches the service', async (code) => {
    const res = await request(app.getHttpServer())
      .put(`${base}/${code}/follow`)
      .send({ clientIds: [], notifyOnNewHearing: true });
    expect(res.status).toBe(200);
    expect(upsertCommitteeFollow).toHaveBeenCalledWith(
      expect.anything(),
      code,
      expect.objectContaining({ notifyOnNewHearing: true }),
    );
  });

  it.each([SENATE, HOUSE])('DELETE %s/follow is mounted and reaches the service', async (code) => {
    const res = await request(app.getHttpServer()).delete(`${base}/${code}/follow`);
    expect(res.status).toBe(200);
    expect(unfollowCommittee).toHaveBeenCalledWith(expect.anything(), code);
  });

  it.each([SENATE, HOUSE])(
    'GET %s/intelligence-history is mounted and reaches the service',
    async (code) => {
      const res = await request(app.getHttpServer()).get(`${base}/${code}/intelligence-history`);
      expect(res.status).toBe(200);
      expect(committeeIntelligenceHistory).toHaveBeenCalledWith(
        expect.anything(),
        code,
        expect.anything(),
      );
    },
  );

  it('accepts the full query string the Committee Room actually sends', async () => {
    const res = await request(app.getHttpServer())
      .get(`${base}/${SENATE}/intelligence-history`)
      .query({
        insightType: 'COMMITMENT',
        includeSubcommittees: 'true',
        dateFrom: '2026-01-01',
        dateTo: '2026-09-05',
        speaker: 'Reed',
        agency: 'Department of the Army',
        bill: 'H.R. 8800',
        programElement: '0604256A',
        relevanceBand: 'HIGH',
        pageSize: '25',
      });

    // A 400 here means the whitelisting ValidationPipe rejects the real client
    // contract — the same class of shipped bug as the funding-opportunities 400.
    expect(res.status).toBe(200);
    expect(committeeIntelligenceHistory).toHaveBeenCalledWith(
      expect.anything(),
      SENATE,
      expect.objectContaining({
        insightType: 'COMMITMENT',
        includeSubcommittees: true,
        speaker: 'Reed',
        relevanceBand: 'HIGH',
      }),
    );
  });

  it('does not let the Committee Room route shadow the follow sub-route', async () => {
    // `GET committees/:id` is declared on LiveHearingsController, which the
    // module registers BEFORE this controller. Express matches in registration
    // order, so a wildcard-ish committee route would swallow these paths.
    await request(app.getHttpServer()).get(`${base}/${SENATE}/follow`).expect(200);
    expect(committeeFollowState).toHaveBeenCalledTimes(1);
    expect(committeeIntelligenceHistory).not.toHaveBeenCalled();
  });
});
