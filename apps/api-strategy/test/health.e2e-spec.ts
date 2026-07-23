import { describe, expect, test, beforeAll, afterAll } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { HealthModule } from '../src/health/health.module.js';

describe('api-strategy /strategy-api/health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Boot only the HealthModule (not AppModule) so we don't also boot the
    // Clerk client / Prisma connection — the contract under test is just that
    // the liveness route is reachable at the prod path. We DO apply the global
    // prefix here so the test path matches production (`/strategy-api/health`).
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('strategy-api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  test('GET /strategy-api/health → 200 { ok: true, service: "api-strategy" }', async () => {
    const res = await request(app.getHttpServer()).get('/strategy-api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'api-strategy' });
  });
});
