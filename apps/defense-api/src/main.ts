import 'reflect-metadata';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json, urlencoded } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppModule } from './app.module.js';
import { assertDefenseServeEnvironment } from './config/defense-config.validation.js';
import { JsonLogger } from './observability/json-logger.js';

async function bootstrap(): Promise<void> {
  assertDefenseServeEnvironment();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  app.useLogger(app.get(JsonLogger));

  const config = app.get(ConfigService);
  const bodyLimit = config.get<string>('DEFENSE_HTTP_BODY_LIMIT') ?? '1mb';
  const captureRawBody = (
    request: IncomingMessage,
    _response: ServerResponse,
    body: Buffer,
  ): void => {
    (request as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(body);
  };
  app.use(json({ limit: bodyLimit, verify: captureRawBody }));
  app.use(urlencoded({ extended: false, limit: bodyLimit, verify: captureRawBody }));

  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'healthz', method: RequestMethod.GET },
      { path: 'readyz', method: RequestMethod.GET },
    ],
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      stopAtFirstError: false,
    }),
  );

  const port = Number(config.get<string>('PORT') ?? '4400');
  await app.listen(port, '0.0.0.0');

  Logger.log(
    JSON.stringify({
      event: 'defense-api.started',
      port,
      cutoverMode: config.get<string>('DEFENSE_CUTOVER_MODE') ?? 'dark',
      pid: process.pid,
    }),
    'Bootstrap',
  );
}

bootstrap().catch((error: unknown) => {
  Logger.error(
    JSON.stringify({
      event: 'defense-api.boot_failed',
      message: error instanceof Error ? error.message : String(error),
    }),
    undefined,
    'Bootstrap',
  );
  process.exitCode = 1;
});
