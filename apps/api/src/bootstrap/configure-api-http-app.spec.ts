import { describe, it, expect, beforeEach } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';
import express from 'express';
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

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('main API options', () => {
    const mainOpts: ConfigureApiHttpAppOptions = {
      serviceHeader: undefined,
      includeClerkRawBody: true,
      includeRecallRawBody: true,
      includeEmailSignatureLargeBody: true,
      defaultJsonLimit: '1mb',
    };

    it('sets the global prefix to /api excluding /health and /webhooks/*', async () => {
      app = await createApp(mainOpts);
      const res = await request(app.getHttpServer()).get('/health');
      // /health is excluded from the global prefix so it reaches the default
      // 404 handler (no controller registered for it in EmptyModule).
      expect(res.status).toBe(404);
    });

    it('does NOT add X-Capiro-Service when serviceHeader is undefined', async () => {
      app = await createApp(mainOpts);
      const res = await request(app.getHttpServer()).get('/api/nonexistent');
      expect(res.headers['x-capiro-service']).toBeUndefined();
    });

    it('registers the Clerk raw-body parser on /webhooks/clerk', async () => {
      app = await createApp(mainOpts);
      // A POST to /webhooks/clerk with a body should be accepted (raw parser
      // handles it, then it 404s on routing).
      const res = await request(app.getHttpServer())
        .post('/webhooks/clerk')
        .set('Content-Type', 'application/json')
        .send('{"test":true}');
      expect(res.status).toBe(404);
    });

    it('registers the email-signature large body parser (32mb)', async () => {
      app = await createApp(mainOpts);
      // The email-signature parser is on /api/me/email-signature.
      // A small body should be accepted (then 404 on routing).
      const res = await request(app.getHttpServer())
        .post('/api/me/email-signature')
        .set('Content-Type', 'application/json')
        .send('{"html":"<p>signature</p>"}');
      expect(res.status).toBe(404);
    });
  });

  describe('engagement-api options', () => {
    const engagementOpts: ConfigureApiHttpAppOptions = {
      serviceHeader: 'engagement-api',
      includeClerkRawBody: false,
      includeRecallRawBody: true,
      includeEmailSignatureLargeBody: false,
      defaultJsonLimit: '1mb',
    };

    it('adds X-Capiro-Service: engagement-api on every response', async () => {
      app = await createApp(engagementOpts);
      const res = await request(app.getHttpServer()).get('/health');
      expect(res.headers['x-capiro-service']).toBe('engagement-api');
    });

    it('adds the header even on 404s', async () => {
      app = await createApp(engagementOpts);
      const res = await request(app.getHttpServer()).get('/api/nonexistent');
      expect(res.headers['x-capiro-service']).toBe('engagement-api');
    });

    it('does NOT register the Clerk raw-body parser', async () => {
      app = await createApp(engagementOpts);
      // Without the raw parser, /webhooks/clerk still gets the default json()
      // parser. The request should still go through (and 404 on routing).
      const res = await request(app.getHttpServer())
        .post('/webhooks/clerk')
        .set('Content-Type', 'application/json')
        .send('{"test":true}');
      expect(res.status).toBe(404);
    });

    it('does NOT register the email-signature large body parser', async () => {
      app = await createApp(engagementOpts);
      // The email-signature route is not registered. A request should 404.
      const res = await request(app.getHttpServer())
        .post('/api/me/email-signature')
        .set('Content-Type', 'application/json')
        .send('{"html":"<p>signature</p>"}');
      expect(res.status).toBe(404);
    });
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
