import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  ORG_TENANT_RESOLVER,
  TenantGuard as ClerkTenantGuard,
  type AuthTenantContext,
  type OrgTenantResolver,
} from '@capiro/auth';

const SECRET_HEADER = 'x-internal-service-secret';
const DELEGATED_TENANT_HEADER = 'x-capiro-delegated-tenant';
const DELEGATED_USER_HEADER = 'x-capiro-delegated-user';

/**
 * MeriV2's tenant guard: the standard Clerk path, PLUS a narrow
 * service-to-service path for trusted backend callers.
 *
 * Why this exists
 * ---------------
 * intel-api's live-hearing gateway calls the MeriV2 tool registry once per
 * final transcript segment. It used to authenticate those calls by REPLAYING
 * the browser's Clerk JWT — captured from the WebSocket query string at connect
 * time and retained for the life of the socket (up to four hours). Clerk
 * session tokens live ~60 seconds, so most of those calls were made with an
 * expired credential; they failed, and because the orchestrator client degrades
 * gracefully, the failure surfaced as silently missing AI extraction rather
 * than an error.
 *
 * The gateway no longer holds a user token at all, so it presents the shared
 * INTERNAL_SERVICE_SECRET together with an explicitly DELEGATED tenant and
 * user.
 *
 * Why this is not a bypass
 * ------------------------
 * The delegated path still resolves the tenant canonically and still requires
 * an ACTIVE local membership for the delegated user. A revoked user cannot be
 * impersonated through it. Delegation supplies identity; it does not grant
 * authorization.
 *
 * Deliberately LOCAL to MeriV2 rather than added to the shared
 * @capiro/auth TenantGuard: only this service needs a service-to-service path,
 * and widening the shared guard would put the same branch on all 38
 * @UseGuards(TenantGuard) sites across four services.
 *
 * Fail-closed: with INTERNAL_SERVICE_SECRET unset the branch is disabled
 * entirely and every request takes the Clerk path.
 */
@Injectable()
export class MeriTenantGuard implements CanActivate {
  private readonly logger = new Logger(MeriTenantGuard.name);

  constructor(
    private readonly clerkGuard: ClerkTenantGuard,
    private readonly config: ConfigService,
    @Inject(ORG_TENANT_RESOLVER) private readonly tenants: OrgTenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();

    const expected = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    const provided = req.headers[SECRET_HEADER];

    // Only take the service path when the secret is configured AND matches.
    // Anything else falls through to the normal Clerk verification.
    if (!expected || typeof provided !== 'string' || provided !== expected) {
      return this.clerkGuard.canActivate(context);
    }

    const tenantId = headerValue(req, DELEGATED_TENANT_HEADER);
    const clerkUserId = headerValue(req, DELEGATED_USER_HEADER);
    if (!tenantId || !clerkUserId) {
      throw new ForbiddenException(
        'Internal service call must delegate both a tenant and a user identity',
      );
    }

    const resolved = await this.tenants.resolveByTenantId(tenantId);
    if (!resolved) {
      throw new ForbiddenException('No tenant for the delegated identity');
    }

    // The delegated user must STILL hold an active membership. This is what
    // keeps delegation from becoming an impersonation primitive.
    if (!(await this.tenants.hasActiveMembership(resolved.tenantId, clerkUserId))) {
      this.logger.warn(
        JSON.stringify({
          security_event: 'auth.denied',
          reason: 'no_active_membership',
          surface: 'internal_service',
          tenant_id: resolved.tenantId,
          clerk_user_id: clerkUserId,
          count: 1,
        }),
      );
      throw new ForbiddenException('Delegated user has no active membership for this tenant');
    }

    req.tenantContext = {
      tenantId: resolved.tenantId,
      clerkUserId,
      role: null,
    };
    return true;
  }
}

function headerValue(req: Request, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : undefined;
}
