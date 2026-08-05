import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { EngagementApiAppModule } from './engagement-api.app.module.js';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
} from './bootstrap/configure-api-http-app.js';

async function bootstrap() {
  // ConfigModule is global; validation runs through the schema's validate
  // function which enforces the shadow matrix cross-field rules.
  const app = await NestFactory.create(EngagementApiAppModule, { bufferLogs: true });
  const logger = new Logger('EngagementApiBootstrap');

  // Shared HTTP pipeline — same ordering and limits as the main API,
  // but with the engagement-api service header on every response.
  // Clerk raw-body parser is NOT needed (no Clerk webhook in this app).
  // Recall raw-body parser IS configured for bootstrap parity (no Recall
  // handler exists yet, but the parser is ready for a later phase).
  // Email-signature large body parser is NOT needed (that route belongs to
  // the main API's /me/email-signature, which is not registered here).
  configureApiHttpApp(app, {
    serviceHeader: 'engagement-api',
    includeClerkRawBody: false,
    includeRecallRawBody: true,
    includeEmailSignatureLargeBody: false,
    defaultJsonLimit: '1mb',
  });

  const port = Number.parseInt(
    process.env.ENGAGEMENT_API_PORT ?? '4500',
    10,
  );
  const host = process.env.ENGAGEMENT_API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Shared server timeout configuration — same as main API.
  configureApiHttpServerTimeouts(app.getHttpServer());

  logger.log(`Capiro engagement-api listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal engagement-api bootstrap error', err);
  process.exit(1);
});
