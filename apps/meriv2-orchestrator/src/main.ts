import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger:
      (process.env.MERIV2_LOG_LEVEL ?? 'debug') === 'debug'
        ? ['error', 'warn', 'log', 'debug']
        : ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // Mount everything under `/meri-api/*` to match the ALB listener rule
  // (priority 15) that forwards `/meri-api/*` to this service without stripping
  // the prefix. Health lives at `/meri-api/health` (UNDER the prefix, but
  // ungated — HealthController has no guard) so both the external SC0.1 probe
  // (`curl .../meri-api/health`) and the ALB target group health check reach it.
  app.setGlobalPrefix('meri-api');

  app.use(json({ limit: '8mb' }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const allowedOrigins = new Set(
    [
      ...(process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173']),
      'https://app.capiro.ai',
      'https://capiro.ai',
      'https://www.capiro.ai',
    ]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      logger.warn(`CORS: rejected origin ${origin}`);
      callback(null, false);
    },
    credentials: true,
  });

  const port = Number.parseInt(process.env.MERIV2_PORT ?? '4300', 10);
  const host = process.env.MERIV2_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Behind the ALB these must outlast the ALB idle timeout (300s) — mirrors the
  // apps/workspace tuning (keepAliveTimeout < headersTimeout).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro MeriV2 Orchestrator listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
