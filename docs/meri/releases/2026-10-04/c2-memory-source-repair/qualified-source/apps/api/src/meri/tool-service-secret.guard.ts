import { createHash, timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../config/config.schema.js';

/** Fixed-length constant-time comparison; neither secret is logged or returned. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/**
 * Service-identity boundary for delegated tools and action-proposal creation.
 * User authentication remains mandatory through the normal API middleware;
 * this guard is the additional server-to-server identity proof.
 */
@Injectable()
export class ToolServiceSecretGuard implements CanActivate {
  private readonly logger = new Logger(ToolServiceSecretGuard.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const environment = this.config.get('NODE_ENV', { infer: true });
    const productionLike = environment === 'staging' || environment === 'production';
    const explicitlyEnforced = this.config.get('MERI_TOOLS_REQUIRE_SERVICE_SECRET', {
      infer: true,
    });
    const enforce = productionLike || explicitlyEnforced;
    const expected = this.config.get('INTERNAL_SERVICE_SECRET', { infer: true });

    if (!expected) {
      if (enforce) {
        throw new ForbiddenException('Internal service identity is not configured for this route');
      }
      this.logger.warn('[tool-service-secret] development/test observe mode: secret is not configured');
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers['x-internal-service-secret'];
    const provided = typeof header === 'string' ? header : null;
    if (provided && secretsMatch(provided, expected)) return true;

    if (enforce) {
      throw new ForbiddenException('This route requires a valid internal service identity');
    }

    // Observe-only is deliberately limited to development/test and must be explicit
    // through MERI_TOOLS_REQUIRE_SERVICE_SECRET=false (its default).
    this.logger.warn(
      `[tool-service-secret] development/test observe mode denied identity was observed for ${request.method ?? 'request'} ${request.path ?? request.url ?? 'unknown-route'}`,
    );
    return true;
  }
}
