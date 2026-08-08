import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

/**
 * Strict service-to-service identity for MeriV3's internal execution bridges.
 *
 * ToolServiceSecretGuard intentionally supports an observe-only rollout mode
 * for legacy endpoints. The V3 managed-app and visual-analysis bridges are new
 * surfaces and have no compatibility reason to accept a user bearer alone, so
 * this guard always enforces the shared secret and fails closed when the secret
 * is not configured.
 */
@Injectable()
export class MeriV3InternalServiceGuard implements CanActivate {
  private readonly expected: string | null;

  constructor(config: ConfigService) {
    const configured = config.get<string>('INTERNAL_SERVICE_SECRET')?.trim();
    this.expected = configured || null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) {
      throw new ServiceUnavailableException('MeriV3 internal service identity is not configured');
    }
    const request = context.switchToHttp().getRequest<Request>();
    const raw = request.headers['x-internal-service-secret'];
    const provided = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    const actualBytes = Buffer.from(provided, 'utf8');
    const expectedBytes = Buffer.from(this.expected, 'utf8');
    const matches =
      actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
    if (!matches) throw new ForbiddenException('Forbidden');
    return true;
  }
}
