import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { json } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    // Surface debug logs (e.g. the tenant guard's "Clerk verifyToken failed"
    // diagnostics) so auth/tenant rejections are visible in CloudWatch. Set
    // WORKSPACE_LOG_LEVEL=log to quiet debug once stable.
    logger:
      (process.env.WORKSPACE_LOG_LEVEL ?? 'debug') === 'debug'
        ? ['error', 'warn', 'log', 'debug']
        : ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // Mount everything under `/workspace-api/*` to match the ALB listener rule
  // that will forward `/workspace-api/*` to this service without stripping the
  // prefix. One carve-out:
  //   - `/health` , the ALB target group hits this, and we don't want it
  //                 nested under /workspace-api.
  app.setGlobalPrefix('workspace-api', {
    exclude: [{ path: 'health', method: RequestMethod.ALL }],
  });

  // Standard JSON body parser. 8mb headroom: the EditorPage autosave PATCHes the
  // WHOLE config in one body — a base64 letterhead logo (up to ~2.7MB) PLUS the
  // full document body PLUS linked-PE context — so 1mb (or even 5mb) could 413.
  app.use(json({ limit: '8mb' }));

  // Strict input validation at the edge, drop unknown fields, fail closed
  // on malformed bodies. class-validator + class-transformer must be installed
  // (apps/workspace/package.json) for this to work.
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
      // Log the rejected origin so misconfig is diagnosable (the default
      // message hides which origin failed), then reject without throwing a
      // 500 — a CORS denial should surface as a blocked request, not an
      // ExceptionsHandler error.
      logger.warn(`CORS: rejected origin ${origin}`);
      callback(null, false);
    },
    credentials: true,
  });

  const port = Number.parseInt(process.env.WORKSPACE_PORT ?? '4200', 10);
  const host = process.env.WORKSPACE_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Behind the ALB these must outlast the ALB idle timeout (300s), or two
  // things break: (1) long requests get their socket cut by the server before
  // the response is sent, and (2) the ALB can reuse a connection the server
  // just closed → sporadic 502s. Node's defaults (keepAlive 5s, headers 60s)
  // are far too low. headersTimeout must exceed keepAliveTimeout.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro Workspace listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
