import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
} from './bootstrap/configure-api-http-app.js';
import { assertEngagementRuntimeEnvironment } from './engagement/runtime/engagement-runtime-env.js';

async function bootstrap() {
  // Fail before Nest constructs providers, connects to the database, or starts
  // an OnModuleInit hook when an Engagement runtime control is malformed.
  assertEngagementRuntimeEnvironment(process.env as Record<string, unknown>);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  configureApiHttpApp(app, {
    serviceHeader: undefined,
    includeClerkRawBody: true,
    includeRecallRawBody: true,
    includeTangoRawBody: true,
    includeEmailSignatureLargeBody: true,
    defaultJsonLimit: '1mb',
  });

  const port = Number.parseInt(process.env.API_PORT ?? '4000', 10);
  const host = process.env.API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);
  configureApiHttpServerTimeouts(app.getHttpServer());
  logger.log(`Capiro API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
