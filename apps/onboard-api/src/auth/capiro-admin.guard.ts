import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService, type ClerkSessionClaims } from '@capiro/auth';
import { CAPIRO_INTERNAL_SLUG } from './billing-actor.guard.js';

/**
 * Cross-tenant staff gate: only admins of the reserved `capiro-internal`
 * Clerk org pass (the capiro_admin role — same derivation as apps/api's
 * mapClerkRoleToCapiro). Used for the comp toggle and CS-side onboarding
 * actions.
 */
@Injectable()
export class CapiroAdminGuard implements CanActivate {
  private readonly logger = new Logger(CapiroAdminGuard.name);

  constructor(private readonly clerk: ClerkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { capiroAdmin?: { clerkUserId: string } }>();

    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
    const token = match?.[1]?.trim();
    if (!token) throw new UnauthorizedException('Missing or malformed Authorization header');

    let claims: ClerkSessionClaims;
    try {
      claims = await this.clerk.verifySessionToken(token);
    } catch (err) {
      this.logger.debug(`Clerk verifyToken failed: ${(err as Error).message}`);
      throw new UnauthorizedException('Invalid session token');
    }
    if (!claims.sub) throw new UnauthorizedException('Token missing subject');

    // Fast path: org claims present in the token (Clerk default session token).
    const orgSlug = claims.org_slug ?? null;
    const orgRole = (claims.org_role ?? claims.capiro_org_role ?? '').toLowerCase();
    if (orgSlug === CAPIRO_INTERNAL_SLUG && orgRole.includes('admin')) {
      req.capiroAdmin = { clerkUserId: claims.sub };
      return true;
    }

    // Fallback: the `capiro` JWT template (what apps/web actually sends via
    // useApi) carries NO org_slug/org_role claims — deliberately, see the
    // template-drift note in apps/api. Without this Backend-API membership
    // check every comp-toggle click from Settings → Customers 403'd. Resolve
    // the user's org memberships server-side and pass capiro-internal admins.
    if (await this.isCapiroInternalAdmin(claims.sub)) {
      req.capiroAdmin = { clerkUserId: claims.sub };
      return true;
    }
    throw new ForbiddenException('Capiro staff only');
  }

  private async isCapiroInternalAdmin(clerkUserId: string): Promise<boolean> {
    try {
      const memberships = await this.clerk.backend.users.getOrganizationMembershipList({
        userId: clerkUserId,
        limit: 50,
      });
      return memberships.data.some(
        (m) =>
          m.organization.slug === CAPIRO_INTERNAL_SLUG && m.role.toLowerCase().includes('admin'),
      );
    } catch (err) {
      // Fail CLOSED: a Backend API hiccup must never grant staff access.
      this.logger.warn(`capiro-admin membership lookup failed: ${(err as Error).message}`);
      return false;
    }
  }
}
