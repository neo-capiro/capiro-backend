import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { json } from 'express';
import { AppModule } from './app.module.js';

/**
 * Capiro Intel API — modular intelligence service.
 *
 * First capability: Live Hearing Intelligence (Deepgram streaming). Future
 * intel capabilities (votes, regulatory, fiscal) migrate INTO this service
 * rather than apps/api. Modeled on apps/workspace (own ECR/Fargate task,
 * deps @capiro/shared + @capiro/meriv2-core only).
 */
async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    logger:
      (process.env.INTEL_LOG_LEVEL ?? 'debug') === 'debug'
        ? ['error', 'warn', 'log', 'debug']
        : ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // WebSocket adapter for the Live Hearing audio-stream gateway (ws library).
  app.useWebSocketAdapter(new WsAdapter(app));

  // Mount HTTP routes under `/intel-api/*` to match the ALB listener rule that
  // forwards `/intel-api/*` to this service without stripping the prefix.
  // `/health` is carved out so the ALB target group can hit it ungated.
  app.setGlobalPrefix('intel-api', {
    exclude: [{ path: 'health', method: RequestMethod.ALL }],
  });

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

  const port = Number.parseInt(process.env.INTEL_PORT ?? '4300', 10);
  const host = process.env.INTEL_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Behind the ALB these must outlast the ALB idle timeout. Live Hearing holds
  // WebSocket connections for the duration of a hearing (potentially hours), so
  // the ALB idle timeout is raised separately in infra; these HTTP keep-alive
  // values mirror apps/workspace for the REST surface.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro Intel API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
