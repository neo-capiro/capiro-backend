// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or the sibling clerk.service.ts) without EXPLICIT
// prior approval from Neo. This guard gates every authenticated workspace
// route; a subtle change here causes tenant-wide 403/500 outages (mirroring
// the apps/api change-control policy on its tenant-context middleware).
//
// 2026-07-25: canonical org->tenant resolution + active-membership enforcement
// added with Neo's explicit approval. intel-api is an independent FORK of
// @capiro/auth's guard, so this mirrors packages/auth/src/tenant.guard.ts by
// hand — keep the two in step.
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
import {
  OrgTenantResolverService,
  type ResolvedTenant,
} from './org-tenant-resolver.service.js';
import type { WorkspaceTenantContext } from './tenant-context.js';

/**
 * Authenticates a request via the Clerk session JWT and attaches the
 * resolved tenant context to `req.tenantContext`.
 *
 * Order of operations:
 *   1. Read `Authorization: Bearer <jwt>`; missing/malformed → 401.
 *   2. Verify the JWT via ClerkService; invalid → 401.
 *   3. Require `sub`; missing → 401. Checked BEFORE any database work.
 *   4. Resolve the CANONICAL tenant row, preferring `org_id` →
 *      tenants.clerk_org_id and falling back to `capiro_tenant_id` →
 *      tenants.id. Nothing resolvable → 403.
 *   5. Cross-check the remaining claims against that row; disagreement → 403.
 *   6. Require an ACTIVE local tenant_memberships row → else 403.
 *   7. Attach the context, with tenantId ALWAYS the canonical UUID.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This guard used to do `tenantId = capiro_tenant_id ?? org_id` with no
 * database access, and the doc comment openly deferred the membership check to
 * a "Phase 3" that never landed. Consequences:
 *
 *   (a) With only `org_id` present it injected a raw `org_...` string as the
 *       tenant id — not a UUID, not any row's key.
 *   (b) `capiro_tenant_id` is server-minted from org public_metadata, so it is
 *       not attacker-controlled, but it was never reconciled against the
 *       canonical row, so a stale value silently pointed an org at the wrong
 *       tenant.
 *   (c) THE REAL HOLE: no membership check. A user whose Capiro membership is
 *       'removed' kept full access while they remained in the Clerk org —
 *       precisely the state a failed Clerk-side delete leaves behind.
 *
 * NEVER synthesize `clerkUserId = 'pending:<id>'`; that pattern has caused
 * downstream 500s in apps/api and is explicitly banned here.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly clerk: ClerkService,
    private readonly tenants: OrgTenantResolverService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: WorkspaceTenantContext }>();

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

    if (!claims.sub) {
      // Defensive: a verified Clerk JWT always carries `sub`. If it doesn't,
      // something is very wrong; fail closed rather than synthesize a
      // placeholder. Checked before any DB work.
      throw new UnauthorizedException('Token missing subject');
    }

    const claimedOrgId = nonEmpty(claims.org_id);
    const claimedTenantId = nonEmpty(claims.capiro_tenant_id);
    const claimedSlug = nonEmpty(claims.capiro_tenant_slug);

    if (!claimedOrgId && !claimedTenantId) {
      throw new ForbiddenException('No tenant in token');
    }

    let resolved: ResolvedTenant | null = null;
    if (claimedOrgId) {
      resolved = await this.tenants.resolveByClerkOrgId(claimedOrgId);
    }
    if (!resolved && claimedTenantId) {
      resolved = await this.tenants.resolveByTenantId(claimedTenantId);
    }
    if (!resolved) {
      this.logger.warn(
        `No tenant for org=${claimedOrgId ?? '-'} tenantClaim=${claimedTenantId ?? '-'}`,
      );
      throw new ForbiddenException('No tenant for the supplied identifiers');
    }

    if (claimedTenantId && resolved.tenantId !== claimedTenantId) {
      throw new ForbiddenException('Tenant claim mismatch, re-auth required');
    }
    // Conditional on clerkOrgId being set: a tenant never linked to a Clerk org
    // has nothing to compare against, and an unconditional check would lock
    // those tenants out.
    if (claimedOrgId && resolved.clerkOrgId && resolved.clerkOrgId !== claimedOrgId) {
      throw new ForbiddenException('Org claim mismatch, re-auth required');
    }
    if (claimedSlug && resolved.slug.toLowerCase() !== claimedSlug.toLowerCase()) {
      throw new ForbiddenException('Tenant slug claim mismatch, re-auth required');
    }

    const active = await this.tenants.hasActiveMembership(resolved.tenantId, claims.sub);
    if (!active) {
      // Single-line JSON so a CloudWatch metric filter can count it:
      //   { $.security_event = "auth.denied" }
      this.logger.warn(
        JSON.stringify({
          security_event: 'auth.denied',
          reason: 'no_active_membership',
          tenant_id: resolved.tenantId,
          clerk_user_id: claims.sub,
          count: 1,
        }),
      );
      throw new ForbiddenException('No active membership for this tenant');
    }

    req.tenantContext = {
      // ALWAYS the canonical UUID — never the raw `org_...` claim.
      tenantId: resolved.tenantId,
      clerkUserId: claims.sub,
      role: claims.org_role ?? claims.capiro_org_role ?? null,
    };
    return true;
  }
}

function extractBearerToken(req: Request): string | null {
  // Node lowercases incoming header names; check both the typed `authorization`
  // alias and the raw index in case a proxy re-cased it.
  const header = req.headers.authorization ?? req.headers['Authorization'];
  if (!header || typeof header !== 'string') return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}

/** Clerk's JWT template emits empty strings for `{{org.*}}` placeholders when
 *  the user has no active org. Treat empty as "no signal". */
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
