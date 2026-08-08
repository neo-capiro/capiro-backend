import type { INestApplication } from '@nestjs/common';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { json, raw } from 'express';
import { PrismaClientExceptionFilter } from '../common/prisma-exception.filter.js';

/**
 * Shared HTTP configuration extracted from the main bootstrap (main.ts).
 *
 * Both the main API and the engagement-api use this so that parser ordering,
 * CORS, global prefix, ValidationPipe options, Prisma filter, and server
 * timeouts stay identical without duplicating the setup logic.
 *
 * Ordering (MUST be preserved):
 *   1. global prefix
 *   2. optional service/release identity middleware
 *   3. CORS
 *   4. raw webhook parsers (Clerk, Recall)
 *   5. special email-signature large body parser
 *   6. default JSON parser
 *   7. ValidationPipe
 *   8. PrismaClientExceptionFilter
 */

export interface ConfigureApiHttpAppOptions {
  /** When set, every response gets `X-Capiro-Service: <value>` header. */
  serviceHeader?: string;
  /** When set, every response gets `X-Capiro-Release-Sha: <value>` header. */
  releaseShaHeader?: string;
  /** Register the Clerk webhook raw-body parser on /webhooks/clerk. */
  includeClerkRawBody: boolean;
  /** Register the Recall webhook raw-body parser on /webhooks/recall. */
  includeRecallRawBody: boolean;
  /**
   * Register the Tango webhook raw-body parser on /webhooks/tango (P46).
   * Required for HMAC verification: the signature covers the exact bytes sent,
   * so re-serializing parsed JSON would change key order and whitespace and
   * invalidate every signature.
   */
  includeTangoRawBody: boolean;
  /** Register the 32mb email-signature JSON parser on /api/me/email-signature. */
  includeEmailSignatureLargeBody: boolean;
  /** Default JSON body limit. */
  defaultJsonLimit: string;
}

/**
 * Resolve the CORS allowed-origins set from the raw WEB_ORIGIN env var.
 *
 * The main API allows comma-separated origins via WEB_ORIGIN and always
 * includes the production + onboarding origins.
 */
export function resolvedAllowedOrigins(rawWebOrigin: string | undefined): Set<string> {
  return new Set(
    [
      ...(rawWebOrigin?.split(',') ?? ['http://localhost:5173']),
      'https://capiro.ai',
      'https://www.capiro.ai',
      'https://onboarding.capiro.ai',
    ]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

/**
 * Apply the shared HTTP configuration to a NestJS application.
 *
 * This is the single source of truth for parser/pipeline ordering. Both
 * main.ts and engagement-main.ts call this so that any future change to
 * pipeline ordering or limits propagates to both processes automatically.
 */
export function configureApiHttpApp(
  app: INestApplication,
  options: ConfigureApiHttpAppOptions,
): void {
  // 1. Global prefix — everything under /api, excluding /health and /webhooks/*
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'health', method: RequestMethod.ALL },
      { path: 'webhooks/(.*)', method: RequestMethod.ALL },
    ],
  });

  // 2. Optional identity middleware — installed before CORS and body parsers
  //    so every response, including CORS/parser failures and policy denials,
  //    carries unambiguous process and release provenance.
  if (options.serviceHeader || options.releaseShaHeader) {
    app.use(
      (
        _req: unknown,
        res: { setHeader: (name: string, value: string) => void },
        next: (err?: unknown) => void,
      ) => {
        if (options.serviceHeader) {
          res.setHeader('X-Capiro-Service', options.serviceHeader);
        }
        if (options.releaseShaHeader) {
          res.setHeader('X-Capiro-Release-Sha', options.releaseShaHeader);
        }
        next();
      },
    );
  }

  // 3. CORS — registered before body parsers so short-circuit responses
  //    (e.g. 413 on an oversized upload) still carry CORS headers. The service
  //    identity middleware above also stamps rejected-origin responses.
  const allowedOrigins = resolvedAllowedOrigins(process.env.WEB_ORIGIN);
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

  // 4. Raw webhook parsers — registered before the default JSON parser so
  //    they win for their specific paths.
  if (options.includeClerkRawBody) {
    app.use('/webhooks/clerk', raw({ type: '*/*', limit: '1mb' }));
  }
  if (options.includeRecallRawBody) {
    app.use('/webhooks/recall', raw({ type: '*/*', limit: '1mb' }));
  }
  // P46. Same 1mb ceiling as the other two receivers: an oversized body is
  // refused by express with a 413 before it reaches the controller, so a
  // multi-megabyte payload can never be buffered, hashed, or parsed.
  if (options.includeTangoRawBody) {
    app.use('/webhooks/tango', raw({ type: '*/*', limit: '1mb' }));
  }

  // 5. Email-signature large body parser — mounted before the global json()
  //    so it wins for this path. (CORS is registered above so an over-limit
  //    upload returns a 413 WITH CORS headers, not an opaque cross-origin
  //    failure.)
  if (options.includeEmailSignatureLargeBody) {
    app.use('/api/me/email-signature', json({ limit: '32mb' }));
  }

  // 6. Default JSON parser
  app.use(json({ limit: options.defaultJsonLimit }));

  // 7. Strict input validation at the edge
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  // 8. Map known Prisma errors (e.g. malformed UUID) to 4xx
  app.useGlobalFilters(new PrismaClientExceptionFilter());
}

/**
 * Shared server timeout configuration.
 *
 * Behind the ALB these must outlast the ALB idle timeout (300s):
 *   - keepAliveTimeout: 305s
 *   - headersTimeout: 310s (must exceed keepAliveTimeout)
 */
export function configureApiHttpServerTimeouts(server: {
  keepAliveTimeout: number;
  headersTimeout: number;
}): void {
  server.keepAliveTimeout = 305_000;
  server.headersTimeout = 310_000;
}
