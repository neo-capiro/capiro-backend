// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or the sibling clerk.service.ts) without EXPLICIT
// prior approval from Neo. This guard gates every authenticated route of its
// consumers (apps/workspace, apps/api-strategy, apps/meriv2-orchestrator,
// apps/onboard-api — 38 @UseGuards(TenantGuard) sites); a subtle change here
// causes tenant-wide 403/500 outages (mirroring the apps/api change-control
// policy on its tenant-context middleware). Shared module per auth-extraction
// Option N (DECISIONS D8).
//
// 2026-07-25: canonical org->tenant resolution + active-membership enforcement
// added with Neo's explicit approval (the "Option F" question was put to him
// directly and approved).
// ============================================================================
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService, type ClerkSessionClaims } from './clerk.service';
import { ORG_TENANT_RESOLVER, type OrgTenantResolver, type ResolvedTenant } from './org-tenant-resolver';
import type { AuthTenantContext } from './tenant-context';

/**
 * Authenticates a request via the Clerk session JWT and attaches the resolved
 * tenant context to `req.tenantContext`.
 *
 * Order of operations:
 *   1. Read `Authorization: Bearer <jwt>`; missing/malformed → 401.
 *   2. Verify the JWT via ClerkService; invalid → 401.
 *   3. Require `sub`; missing → 401. (Checked BEFORE any database work so a
 *      subject-less token never costs a round-trip.)
 *   4. Resolve the CANONICAL tenant row from the verified claims, preferring
 *      `org_id` → tenants.clerk_org_id, falling back to `capiro_tenant_id` →
 *      tenants.id. Nothing resolvable → 403.
 *   5. Cross-check every other claim against that row; any disagreement → 403.
 *   6. Require an ACTIVE local tenant_memberships row → else 403.
 *   7. Attach `req.tenantContext = { tenantId, clerkUserId, role }`, where
 *      tenantId is ALWAYS the canonical UUID.
 *
 * WHAT CHANGED AND WHY
 * --------------------
 * This guard used to do `tenantId = capiro_tenant_id ?? org_id` with zero
 * database access, and treated that string as the tenant for the rest of the
 * request. Three concrete problems, in ascending order of severity:
 *
 *   (a) When only `org_id` was present it injected a raw `org_...` string as
 *       `tenantId`. That is not a UUID and is not any row's primary key, so
 *       every downstream tenant predicate silently matched nothing.
 *   (b) `capiro_tenant_id` comes from the Clerk org's public_metadata, which
 *       only Capiro's backend writes. It is therefore NOT attacker-controlled —
 *       but it IS un-reconciled: a stale or mis-set public_metadata value
 *       pointed a whole organization at the wrong tenant with nothing to catch
 *       it. Resolving from the database and requiring agreement catches it.
 *   (c) THE REAL HOLE: there was no membership check at all. A user whose
 *       Capiro `tenant_memberships` row is 'removed' or 'suspended' kept full
 *       access for as long as they remained in the Clerk organization — which
 *       is exactly the state left behind when the Clerk-side delete fails.
 *       apps/api has always enforced this; these four services never did. This
 *       matters most in apps/workspace, whose ws_* tables have NO Postgres RLS,
 *       so this guard plus explicit tenantId predicates ARE the isolation
 *       boundary.
 *
 * The resolver is a REQUIRED constructor dependency, never @Optional(). An
 * optional dependency fails OPEN — a service that forgot to register the
 * provider would silently keep the old unverified behaviour. Required means it
 * fails to boot instead, which is the correct direction.
 *
 * NEVER synthesize `clerkUserId = 'pending:<id>'`; that pattern has caused
 * downstream 500s in apps/api and is explicitly banned here.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  private readonly logger = new Logger(TenantGuard.name);

  constructor(
    private readonly clerk: ClerkService,
    @Inject(ORG_TENANT_RESOLVER) private readonly tenants: OrgTenantResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: AuthTenantContext }>();

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

    // Before any DB work: a verified Clerk JWT always carries `sub`. Fail
    // closed rather than synthesize a placeholder.
    if (!claims.sub) {
      throw new UnauthorizedException('Token missing subject');
    }

    const claimedOrgId = nonEmpty(claims.org_id);
    const claimedTenantId = nonEmpty(claims.capiro_tenant_id);
    const claimedSlug = nonEmpty(claims.capiro_tenant_slug);

    if (!claimedOrgId && !claimedTenantId) {
      throw new ForbiddenException('No tenant in token');
    }

    // Step 4 — canonical resolution. org_id first (Clerk is the source of truth
    // for organization identity); capiro_tenant_id is the fallback so tenants
    // whose row has no clerk_org_id yet are not locked out.
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

    // Step 5 — integrity cross-checks, mirroring apps/api's middleware. Each
    // covers a different way the token and the canonical row can disagree.
    if (claimedTenantId && resolved.tenantId !== claimedTenantId) {
      throw new ForbiddenException('Tenant claim mismatch, re-auth required');
    }
    // Conditional on clerkOrgId being set: a tenant that has never been linked
    // to a Clerk org has nothing to compare against, and making this
    // unconditional would lock those tenants out entirely.
    if (claimedOrgId && resolved.clerkOrgId && resolved.clerkOrgId !== claimedOrgId) {
      throw new ForbiddenException('Org claim mismatch, re-auth required');
    }
    if (claimedSlug && resolved.slug.toLowerCase() !== claimedSlug.toLowerCase()) {
      throw new ForbiddenException('Tenant slug claim mismatch, re-auth required');
    }

    // Step 6 — the local membership must be ACTIVE. A valid Clerk token is no
    // longer sufficient on its own.
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
