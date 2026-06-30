import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';

/**
 * Boots the full orchestrator AppModule (no DB connection — PrismaService is
 * lazy) and asserts the health + auth contract:
 *   - /meri-api/health is ungated → 200 (SC0.1 local proof)
 *   - every /meri-api/tools route is behind TenantGuard → 401 without a JWT
 *     (toward SC0.7: no unauthenticated access)
 */
describe('MeriV2 orchestrator (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('meri-api');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /meri-api/health → 200 (ungated)', async () => {
    const res = await request(app.getHttpServer()).get('/meri-api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, service: 'meriv2-orchestrator' });
  });

  it('GET /meri-api/tools without auth → 401', async () => {
    const res = await request(app.getHttpServer()).get('/meri-api/tools');
    expect(res.status).toBe(401);
  });

  it('POST /meri-api/tools/get_client_context/invoke without auth → 401', async () => {
    const res = await request(app.getHttpServer())
      .post('/meri-api/tools/get_client_context/invoke')
      .send({ input: { clientId: '11111111-1111-4111-8111-111111111111' } });
    expect(res.status).toBe(401);
  });
});
