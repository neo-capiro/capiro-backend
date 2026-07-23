import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Surface debug logs (e.g. the tenant guard's "Clerk verifyToken failed"
    // diagnostics) so auth/tenant rejections are visible in CloudWatch. Set
    // STRATEGY_LOG_LEVEL=log to quiet debug once stable.
    logger:
      (process.env.STRATEGY_LOG_LEVEL ?? 'debug') === 'debug'
        ? ['error', 'warn', 'log', 'debug']
        : ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // Mount everything under `/strategy-api/*` to match the ALB listener rule
  // that forwards `/strategy-api/*` to this service without stripping the
  // prefix. Health lives under the prefix (`/strategy-api/health`) — it is
  // ungated (no TenantGuard on the controller), mirroring meriv2-orchestrator.
  app.setGlobalPrefix('strategy-api');

  // Standard JSON body parser with headroom for plan snapshots / draft payloads.
  app.use(json({ limit: '8mb' }));

  // Strict input validation at the edge: drop unknown fields, fail closed on
  // malformed bodies. class-validator + class-transformer must be installed.
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
      // Log the rejected origin so misconfig is diagnosable, then reject without
      // throwing a 500 — a CORS denial should surface as a blocked request.
      logger.warn(`CORS: rejected origin ${origin}`);
      callback(null, false);
    },
    credentials: true,
  });

  const port = Number.parseInt(process.env.STRATEGY_PORT ?? '4400', 10);
  const host = process.env.STRATEGY_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Behind the ALB these must outlast the ALB idle timeout (300s), or long
  // requests get cut and reused-connection 502s appear. headersTimeout must
  // exceed keepAliveTimeout. (Mirrors apps/workspace + apps/meriv2-orchestrator.)
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro Strategy API listening on http://${host}:${port} (prefix /strategy-api)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
