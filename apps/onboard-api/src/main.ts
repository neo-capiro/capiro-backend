import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express, { json, type NextFunction, type Request, type Response } from 'express';
import { AppModule } from './app.module.js';

/**
 * Capiro Onboard API — self-service onboarding + billing service.
 *
 * One container serves two surfaces behind the shared ALB:
 *   • `/onboard-api/*`  — the REST API (any host; the SPA and apps/web both
 *     call it, and Stripe webhooks land at /onboard-api/webhooks/stripe).
 *   • everything else   — the onboard-web SPA static bundle (reached via the
 *     `onboarding.capiro.ai` host rule; funnel + external setup dashboard +
 *     IT-admin page).
 *
 * Modeled on apps/intel-api (own ECR/Fargate task, own onboard_* prisma
 * schema, @capiro/auth narrow guard).
 */
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    logger:
      (process.env.ONBOARD_LOG_LEVEL ?? 'log') === 'debug'
        ? ['error', 'warn', 'log', 'debug']
        : ['error', 'warn', 'log'],
  });
  const logger = new Logger('Bootstrap');

  // Mount HTTP routes under `/onboard-api/*` to match the ALB listener rule
  // that forwards `/onboard-api/*` without stripping the prefix. `/health` is
  // carved out so the ALB target group can hit it ungated.
  app.setGlobalPrefix('onboard-api', {
    exclude: [{ path: 'health', method: RequestMethod.ALL }],
  });

  // Stripe webhook signature verification needs the RAW body. Register the
  // raw-body parser for that exact path BEFORE the json parser; the webhook
  // controller reads req.body as a Buffer.
  app.use('/onboard-api/webhooks/stripe', express.raw({ type: '*/*', limit: '2mb' }));
  app.use(json({ limit: '2mb' }));

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
      ...(process.env.WEB_ORIGIN?.split(',') ?? ['http://localhost:5173', 'http://localhost:5174']),
      'https://app.capiro.ai',
      'https://onboarding.capiro.ai',
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

  // ── onboard-web SPA (static) ───────────────────────────────────────────────
  // The Docker build copies the built SPA to ../onboard-web/dist. Locally the
  // SPA runs on its own Vite dev server, so a missing dist just logs a notice.
  const spaDist =
    process.env.ONBOARD_WEB_DIST ?? resolve(process.cwd(), '..', 'onboard-web', 'dist');
  if (existsSync(spaDist)) {
    const staticHandler = express.static(spaDist, { index: false, maxAge: '1h' });
    const indexPath = resolve(spaDist, 'index.html');
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (
        req.method !== 'GET' ||
        req.path.startsWith('/onboard-api') ||
        req.path === '/health'
      ) {
        next();
        return;
      }
      staticHandler(req, res, () => {
        // SPA fallback: every unknown GET path renders the app shell. Never
        // cache the shell so deploys take effect immediately.
        res.setHeader('Cache-Control', 'no-store');
        res.sendFile(indexPath);
      });
    });
    logger.log(`Serving onboard-web SPA from ${spaDist}`);
  } else {
    logger.warn(`onboard-web dist not found at ${spaDist} — API-only mode`);
  }

  const port = Number.parseInt(process.env.ONBOARD_PORT ?? '4400', 10);
  const host = process.env.ONBOARD_BIND_HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // Keep-alive must outlast the ALB idle timeout (mirrors apps/workspace).
  const server = app.getHttpServer();
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;

  logger.log(`Capiro Onboard API listening on http://${host}:${port}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error', err);
  process.exit(1);
});
