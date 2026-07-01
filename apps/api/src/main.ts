import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { json, raw } from 'express';
import { AppModule } from './app.module.js';
import { PrismaClientExceptionFilter } from './common/prisma-exception.filter.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger('Bootstrap');

  // Mount everything under `/api/*` to match the ALB listener rule. The ALB
  // forwards `/api/*` to this service without stripping the prefix, so every
  // controller route lives under `/api/...`. Two carve-outs:
  //   - `/health`  , the ALB target group hits this (and also routes /health
  //                   to the API), and we don't want it nested under /api.
  //   - `/webhooks/*`, Clerk's webhook URL is `/webhooks/clerk` (no /api),
  //                     so the route stays bare-mounted.
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'webhooks/(.*)', method: RequestMethod.ALL },
    ],
  });

  // CORS is registered BEFORE the body parsers below so that EVERY response —
  // including ones that short-circuit during body parsing (e.g. a 413 when an
  // oversized signature upload exceeds the limit) — still carries
  // Access-Control-Allow-Origin. Registered after the parsers, a body-parser
  // error bypasses the CORS middleware, and a cross-origin caller
  // (app.capiro.ai → this API host) sees the real status as an opaque CORS
  // failure ("No 'Access-Control-Allow-Origin' header") instead.
  const allowedOrigins = new Set(
    [
      ...(process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173']),
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
      callback(new Error('Origin is not allowed by CORS'));
    },
    credentials: true,
  });

  // Webhook signature verification needs the raw (unparsed) body. Mount the raw
  // parser ONLY on the webhook paths; everything else gets normal JSON.
  app.use('/webhooks/clerk', raw({ type: '*/*', limit: '1mb' }));
  app.use('/webhooks/stripe', raw({ type: '*/*', limit: '1mb' }));
  // The email-signature endpoint carries a branded HTML signature that can embed
  // a base64 logo / uploaded signature image, so its JSON body legitimately
  // exceeds the global 1mb cap. Give just this route a larger limit: the server
  // caps stored HTML at MAX_SIGNATURE_HTML_LENGTH (sanitize-signature.ts) and
  // base64 inflates ~33%, so this stays comfortably above that cap. Mounted
  // BEFORE the global json() so it wins for this path. (CORS is registered
  // above so an over-limit upload returns a 413 WITH CORS headers, not an
  // opaque cross-origin failure.)
  app.use('/api/me/email-signature', json({ limit: '32mb' }));
  app.use(json({ limit: '1mb' }));

  // Strict input validation at the edge, drop unknown fields, fail closed
  // on malformed bodies. class-validator + class-transformer must be installed
  // (apps/api/package.json) for this to work.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // Map known Prisma errors (e.g. malformed UUID path params) to 4xx instead
  // of a generic 500. Registered after the pipes; only catches Prisma errors,
  // so HttpExceptions still flow through Nest's default handler.
  app.useGlobalFilters(new PrismaClientExceptionFilter());

  const port = Number.parseInt(process.env.API_PORT ?? '4000', 10);
  const host = process.env.API_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Behind the ALB these must outlast the ALB idle timeout (300s), or two
  // things break: (1) long AI content-generation requests (model calls up to
  // ~120s) get their socket cut by the server before the response is sent, and
  // (2) the ALB can reuse a connection the server just closed → sporadic 502s.
  // Node's defaults (keepAlive 5s, headers 60s) are far too low for an
  // AI-heavy app. headersTimeout must exceed keepAliveTimeout.
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
