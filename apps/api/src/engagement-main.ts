import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { EngagementApiAppModule } from './engagement-api.app.module.js';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
} from './bootstrap/configure-api-http-app.js';
import { assertEngagementRuntimeEnvironment } from './engagement/runtime/engagement-runtime-env.js';

async function bootstrap() {
  const posture = assertEngagementRuntimeEnvironment(process.env as Record<string, unknown>);
  if (posture.serviceName !== 'engagement-api') {
    throw new Error('engagement-main requires CAPIRO_SERVICE_NAME=engagement-api');
  }

  const app = await NestFactory.create(EngagementApiAppModule, { bufferLogs: true });
  const logger = new Logger('EngagementApiBootstrap');

  configureApiHttpApp(app, {
    serviceHeader: 'engagement-api',
    releaseShaHeader: process.env.RELEASE_SHA ?? 'UNVERIFIED',
    includeClerkRawBody: false,
    includeRecallRawBody: true,
    // The Tango receiver is hosted by the main API only. The engagement service
    // does not mount WebhooksModule, so a raw parser here would guard a route
    // that does not exist.
    includeTangoRawBody: false,
    includeEmailSignatureLargeBody: false,
    defaultJsonLimit: '1mb',
  });

  const port = Number.parseInt(process.env.ENGAGEMENT_API_PORT ?? '4500', 10);
  const host = process.env.ENGAGEMENT_API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  configureApiHttpServerTimeouts(app.getHttpServer());
  logger.log(`Capiro engagement-api listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal engagement-api bootstrap error', err);
  process.exit(1);
});
