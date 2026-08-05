import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module.js';
import {
  configureApiHttpApp,
  configureApiHttpServerTimeouts,
} from './bootstrap/configure-api-http-app.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  // Shared HTTP pipeline — global prefix, CORS, parsers, ValidationPipe,
  // Prisma filter. Extracted to configureApiHttpApp so both the main API
  // and engagement-api use identical pipeline ordering and limits.
  configureApiHttpApp(app, {
    serviceHeader: undefined, // Main API does not add X-Capiro-Service in Phase 1
    includeClerkRawBody: true,
    includeRecallRawBody: true,
    includeEmailSignatureLargeBody: true,
    defaultJsonLimit: '1mb',
  });

  const port = Number.parseInt(process.env.API_PORT ?? '4000', 10);
  const host = process.env.API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Shared server timeout configuration.
  configureApiHttpServerTimeouts(app.getHttpServer());

  logger.log(`Capiro API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
