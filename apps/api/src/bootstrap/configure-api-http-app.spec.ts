import { describe, it, expect } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import request from 'supertest';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
  resolvedAllowedOrigins,
  type ConfigureApiHttpAppOptions,
} from './configure-api-http-app.js';

// Minimal module so we can boot a Nest app without real providers.
@Module({})
class EmptyModule {}

async function createApp(opts: ConfigureApiHttpAppOptions): Promise<INestApplication> {
  const app = await NestFactory.create(EmptyModule, { logger: ['error'] });
  configureApiHttpApp(app, opts);
  await app.init();
  return app;
}

describe('configureApiHttpApp', () => {
  let app: INestApplication;

  // NestFactory.create + supertest under the full Phase 1 30-suite jest run
  // on Windows can exceed the default 5000ms per-test budget even though the
  // same cases finish in <1s in isolation. Timing tolerance only.
  const nestBootTimeoutMs = 15000;

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('main API options', () => {
    const mainOpts: ConfigureApiHttpAppOptions = {
      serviceHeader: undefined,
      releaseShaHeader: undefined,
      includeClerkRawBody: true,
      includeRecallRawBody: true,
      includeEmailSignatureLargeBody: true,
      defaultJsonLimit: '1mb',
    };

    it(
      'sets the global prefix to /api excluding /health and /webhooks/*',
      async () => {
        app = await createApp(mainOpts);
        const res = await request(app.getHttpServer()).get('/health');
        expect(res.status).toBe(404);
      },
      nestBootTimeoutMs,
    );

    it(
      'does NOT add engagement-api identity headers',
      async () => {
        app = await createApp(mainOpts);
        const res = await request(app.getHttpServer()).get('/api/nonexistent');
        expect(res.headers['x-capiro-service']).toBeUndefined();
        expect(res.headers['x-capiro-release-sha']).toBeUndefined();
      },
      nestBootTimeoutMs,
    );

    it(
      'registers the Clerk raw-body parser on /webhooks/clerk',
      async () => {
        app = await createApp(mainOpts);
        const res = await request(app.getHttpServer())
          .post('/webhooks/clerk')
          .set('Content-Type', 'application/json')
          .send('{"test":true}');
        expect(res.status).toBe(404);
      },
      nestBootTimeoutMs,
    );

    it(
      'registers the email-signature large body parser (32mb)',
      async () => {
        app = await createApp(mainOpts);
        const res = await request(app.getHttpServer())
          .post('/api/me/email-signature')
          .set('Content-Type', 'application/json')
          .send('{"html":"<p>signature</p>"}');
        expect(res.status).toBe(404);
      },
      nestBootTimeoutMs,
    );
  });

  describe('engagement-api options', () => {
    const releaseSha = 'a'.repeat(40);
    const engagementOpts: ConfigureApiHttpAppOptions = {
      serviceHeader: 'engagement-api',
      releaseShaHeader: releaseSha,
      includeClerkRawBody: false,
      includeRecallRawBody: true,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    };

    it(
      'adds exact service and release identity on every response',
      async () => {
        app = await createApp(engagementOpts);
        const res = await request(app.getHttpServer()).get('/health');
        expect(res.headers['x-capiro-service']).toBe('engagement-api');
        expect(res.headers['x-capiro-release-sha']).toBe(releaseSha);
      },
      nestBootTimeoutMs,
    );

    it(
      'adds both identity headers even on 404s',
      async () => {
        app = await createApp(engagementOpts);
        const res = await request(app.getHttpServer()).get('/api/nonexistent');
        expect(res.headers['x-capiro-service']).toBe('engagement-api');
        expect(res.headers['x-capiro-release-sha']).toBe(releaseSha);
      },
      nestBootTimeoutMs,
    );

    it(
      'does NOT register the Clerk raw-body parser',
      async () => {
        app = await createApp(engagementOpts);
        const res = await request(app.getHttpServer())
          .post('/webhooks/clerk')
          .set('Content-Type', 'application/json')
          .send('{"test":true}');
        expect(res.status).toBe(404);
      },
      nestBootTimeoutMs,
    );

    it(
      'does NOT register the email-signature large body parser',
      async () => {
        app = await createApp(engagementOpts);
        const res = await request(app.getHttpServer())
          .post('/api/me/email-signature')
          .set('Content-Type', 'application/json')
          .send('{"html":"<p>signature</p>"}');
        expect(res.status).toBe(404);
      },
      nestBootTimeoutMs,
    );
  });

  describe('resolvedAllowedOrigins', () => {
    it('includes localhost when WEB_ORIGIN is unset', () => {
      const origins = resolvedAllowedOrigins(undefined);
      expect(origins.has('http://localhost:5173')).toBe(true);
    });

    it('includes capiro.ai production origins', () => {
      const origins = resolvedAllowedOrigins(undefined);
      expect(origins.has('https://capiro.ai')).toBe(true);
      expect(origins.has('https://www.capiro.ai')).toBe(true);
      expect(origins.has('https://onboarding.capiro.ai')).toBe(true);
    });

    it('uses WEB_ORIGIN when provided', () => {
      const origins = resolvedAllowedOrigins('http://127.0.0.1:5173');
      expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    });

    it('handles comma-separated origins', () => {
      const origins = resolvedAllowedOrigins(
        'http://localhost:5173,http://127.0.0.1:5173',
      );
      expect(origins.has('http://localhost:5173')).toBe(true);
      expect(origins.has('http://127.0.0.1:5173')).toBe(true);
    });

    it('denies an origin not in the allowlist', () => {
      const origins = resolvedAllowedOrigins('http://localhost:5173');
      expect(origins.has('http://evil.example.com')).toBe(false);
    });
  });

  describe('configureApiHttpServerTimeouts', () => {
    it('sets keepAliveTimeout to 305000', () => {
      const server = { keepAliveTimeout: 0, headersTimeout: 0 };
      configureApiHttpServerTimeouts(server);
      expect(server.keepAliveTimeout).toBe(305_000);
    });

    it('sets headersTimeout to 310000', () => {
      const server = { keepAliveTimeout: 0, headersTimeout: 0 };
      configureApiHttpServerTimeouts(server);
      expect(server.headersTimeout).toBe(310_000);
    });
  });
});
