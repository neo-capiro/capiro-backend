// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or the sibling clerk.service.ts) without EXPLICIT
// prior approval from Neo. This guard gates every authenticated orchestrator
// route; a subtle change here causes tenant-wide 403/500 outages (mirroring
// the apps/api change-control policy on its tenant-context middleware).
// Verbatim port of apps/workspace/src/auth/tenant.guard.ts.
// ============================================================================
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService, type ClerkSessionClaims } from './clerk.service.js';
import type { OrchestratorTenantContext } from './tenant-context.js';

/**
 * Authenticates a request via the Clerk session JWT and attaches the resolved
 * tenant context to `req.tenantContext`.
 *
 * Order of operations:
 *   1. Read `Authorization: Bearer <jwt>`; missing/malformed → 401.
 *   2. Verify the JWT via ClerkService; invalid → 401.
 *   3. Resolve `tenantId` from the verified claims:
 *        a. `capiro_tenant_id` (from the `capiro` JWT template) — preferred,
 *        b. `org_id`           (the Clerk v2 default session token), fallback.
 *      Neither present → 403.
 *   4. Attach `req.tenantContext = { tenantId, clerkUserId, role }`.
 *
 * IMPORTANT: a Phase-1 lightweight resolution from VERIFIED claims only. The
 * orchestrator does not own the tenant/user/membership tables, so we trust the
 * signed claim. The full membership cross-check + Capiro userId resolution
 * (parity with apps/api's TenantContextMiddleware, the SC0.7 gate) happens at
 * the data-adapter boundary for tools that need it.
 *
 * NEVER synthesize `clerkUserId = 'pending:<id>'`; that pattern has caused
 * downstream 500s in apps/api and is explicitly banned here.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(private readonly clerk: ClerkService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: OrchestratorTenantContext }>();

    const token = extractBearerToken(req);
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

    const tenantId = pickTenantId(claims);
    if (!tenantId) {
      throw new ForbiddenException('No tenant in token');
    }

    if (!claims.sub) {
      // Defensive: a verified Clerk JWT always carries `sub`. Fail closed rather
      // than synthesize a placeholder.
      throw new UnauthorizedException('Token missing subject');
    }

    req.tenantContext = {
      tenantId,
      clerkUserId: claims.sub,
      role: claims.org_role ?? claims.capiro_org_role ?? null,
    };
    return true;
  }
}

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function pickTenantId(claims: ClerkSessionClaims): string | null {
  const fromTemplate = claims.capiro_tenant_id?.trim();
  if (fromTemplate) return fromTemplate;
  const fromOrg = claims.org_id?.trim();
  if (fromOrg) return fromOrg;
  return null;
}
