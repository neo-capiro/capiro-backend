import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../config/config.schema.js';

/**
 * Gates a route to trusted BACKEND-SERVICE callers only (currently: intel-api
 * resolving a tenant's AI credential for the live-hearing path, BYOK3) — never
 * a browser-held Clerk JWT. Checks the `x-internal-service-secret` header
 * against `INTERNAL_SERVICE_SECRET` (a static secret shared only between
 * backend services' ECS task defs, never sent to a browser).
 *
 * Deliberately NOT `RolesGuard`: a route returning a raw decrypted provider
 * API key must not be reachable by any ordinary user JWT (a standard_user's
 * own browser could otherwise self-serve their tenant's raw key, which no
 * existing route allows — every AI-key admin endpoint is write-only, never
 * re-displaying the plaintext). Fail-closed: if the secret is unset, the
 * route is unconditionally denied, not left open.
 */
@Injectable()
export class InternalServiceGuard implements CanActivate {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get('INTERNAL_SERVICE_SECRET', { infer: true });
    if (!expected) {
      throw new ForbiddenException(
        'Internal service route is disabled (no shared secret configured)',
      );
    }
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.headers['x-internal-service-secret'];
    if (typeof provided !== 'string' || provided !== expected) {
      throw new ForbiddenException('Invalid or missing internal service secret');
    }
    return true;
  }
}
