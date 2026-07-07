import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService, type ClerkSessionClaims } from '@capiro/auth';

/** Verified purchaser identity attached to funnel requests. */
export interface PurchaserAuth {
  clerkUserId: string;
  email: string | null;
  emailVerified: boolean;
  claims: ClerkSessionClaims;
}

/**
 * Authenticates a request via the Clerk session JWT WITHOUT requiring an
 * organization. The onboarding funnel runs before any tenant/org exists: the
 * purchaser is an org-less Clerk user, so @capiro/auth's TenantGuard (which
 * fails closed on "No tenant in token") cannot gate these routes.
 *
 * Verification is identical (ClerkService.verifySessionToken); only the
 * tenant-resolution step is dropped. Attaches `req.purchaserAuth`.
 */
@Injectable()
export class ClerkUserGuard implements CanActivate {
  private readonly logger = new Logger(ClerkUserGuard.name);

  constructor(private readonly clerk: ClerkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { purchaserAuth?: PurchaserAuth }>();

    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
    const token = match?.[1]?.trim();
    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    let claims: ClerkSessionClaims;
    try {
      claims = await this.clerk.verifySessionToken(token);
    } catch (err) {
      this.logger.debug(`Clerk verifyToken failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid session token');
    }

    if (!claims.sub) {
      throw new UnauthorizedException('Token missing subject');
    }

    const record = claims as unknown as Record<string, unknown>;
    req.purchaserAuth = {
      clerkUserId: claims.sub,
      email: typeof record['email'] === 'string' ? (record['email'] as string) : null,
      emailVerified: record['email_verified'] === true,
      claims,
    };
    return true;
  }
}
