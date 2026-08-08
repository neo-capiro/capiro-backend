import { Controller, Get, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApiHttpApp } from '../../bootstrap/configure-api-http-app.js';

@Controller()
class HeaderProbeController {
  @Get('probe')
  probe(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [HeaderProbeController] })
class HeaderProbeModule {}

describe('engagement-api service identity ordering', () => {
  it('stamps a rejected CORS response before the CORS middleware fails', async () => {
    const previousOrigin = process.env.WEB_ORIGIN;
    process.env.WEB_ORIGIN = 'http://127.0.0.1:5173';
    const moduleRef = await Test.createTestingModule({ imports: [HeaderProbeModule] }).compile();
    const app = moduleRef.createNestApplication();
    configureApiHttpApp(app, {
      serviceHeader: 'engagement-api',
      includeClerkRawBody: false,
      includeRecallRawBody: false,
      includeTangoRawBody: false,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    });

    try {
      await app.init();
      const response = await request(app.getHttpServer())
        .get('/api/probe')
        .set('Origin', 'https://not-allowed.example');
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.headers['x-capiro-service']).toBe('engagement-api');
    } finally {
      await app.close();
      if (previousOrigin === undefined) delete process.env.WEB_ORIGIN;
      else process.env.WEB_ORIGIN = previousOrigin;
    }
  });
});
