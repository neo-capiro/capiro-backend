// ============================================================================
// ⛔ CHANGE-CONTROL: AUTHENTICATION / EMAIL INTEGRATION — APPROVAL REQUIRED
// ----------------------------------------------------------------------------
// Do NOT modify this file (or anything touching Clerk auth, the tenant-context
// middleware, JWT/session handling, Microsoft Graph OAuth, the Clerk webhook,
// or integration connection/token persistence) without EXPLICIT prior approval
// from Neo. These paths gate every authenticated request and the email/Outlook
// integration; a subtle change here has repeatedly caused tenant-wide 403/500
// outages (see git history 2026-06-07 + skill: capiro-tenant-onboarding-flow).
// Investigate read-only and PROPOSE first; wait for go-ahead before editing,
// merging, or deploying.
// ============================================================================
import {
  ForbiddenException,
  Injectable,
  Logger,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { TENANT_HEADER, type TenantContext, type TenantRole } from '@capiro/shared';
import { ClerkService, type ClerkSessionClaims } from '../auth/clerk.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { mapClerkRoleToCapiro } from '../auth/clerk-role.util.js';
import { TenantContextStore } from './tenant-context.store.js';

type SystemTx = Prisma.TransactionClient;
type MembershipWithTenant = Prisma.TenantMembershipGetPayload<{ include: { tenant: true } }>;

/**
 * Resolves the tenant context for an authenticated request.
 *
 * Order of operations:
 *   1. Verify the Clerk session JWT (Authorization: Bearer ...).
 *   2. Resolve the requested tenant. Preference order:
 *        a. `capiro_tenant_id` from the Clerk JWT template (fast path, no
 *            membership scan needed; the org_id claim is cross-checked
 *            against tenants.clerk_org_id).
 *        b. X-Capiro-Tenant header.
 *        c. Subdomain match, `{slug}.app.capiro.ai`.
 *        d. Sole-membership fallback, if the user has exactly one active
 *            membership and none of the above produced a hint, use it.
 *   3. Look up the membership using RLS bypass (the lookup itself is not
 *      tenant-scoped because we are still resolving which tenant to use).
 *   4. Cross-check: if the JWT carries `org_id`, the resolved tenant's
 *      `clerk_org_id` MUST match. Mismatch → 403.
 *   5. Propagate the context via AsyncLocalStorage + req.tenantContext.
 *
 * This is the JWT/host integrity check called out in arch §2.2 and §8.2.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly store: TenantContextStore,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    // Belt-and-suspenders bypass for paths that authenticate via a different
    // channel than the Clerk session. The OAuth callback is reached via a
    // top-level browser redirect from Microsoft and authenticates via the
    // HMAC-signed `state` parameter. Public marketing lead capture has no
    // tenant context by design. The middleware-level `.exclude()` in
    // app.module.ts is the primary mechanism; this is the fallback in case the
    // exclude path matcher misses for any reason (e.g. global prefix
    // interaction).
    const path = req.path;
    const originalUrl = req.originalUrl ?? req.url ?? '';
    const baseUrl = req.baseUrl ?? '';
    const bypassPaths = [
      '/webhooks/clerk',
      '/api/v1/demo-requests',
      '/api/engagement/integrations/microsoft/callback',
      '/api/engagement/integrations/microsoft/notifications',
      '/api/clio/runtime',
      '/api/clio/mcp-oauth/callback',
      '/api/insights',
      // BYOK3 service-to-service endpoints: intel-api resolves a tenant AI
      // credential for live-hearing extraction. These authenticate via
      // InternalServiceGuard (shared INTERNAL_SERVICE_SECRET header), NOT a
      // Clerk session, so they carry no bearer token and must bypass tenant
      // resolution here (the guard reads tenantId from the body). The
      // app.module.ts `.exclude()` misses because setGlobalPrefix('api')
      // shifts the matcher — this internal list is the mechanism that works.
      '/api/internal',
    ];
    if (bypassPaths.some((bypassPath) => isBypassPath(bypassPath, path, originalUrl, baseUrl))) {
      this.logger.log(
        `Bypassing tenant context for public/external route (path=${path}, originalUrl=${originalUrl}, baseUrl=${baseUrl})`,
      );
      next();
      return;
    }

    // Step 1, verify Clerk JWT.
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = auth.slice('bearer '.length).trim();

    let claims: ClerkSessionClaims;
    try {
      claims = await this.clerk.verifySessionToken(token);
    } catch {
      throw new UnauthorizedException('Invalid session token');
    }

    // Step 2, gather every hint we have about which tenant is being requested.
    // Empty strings from the JWT template (when the user has no active org)
    // are normalized to undefined so the downstream logic only sees real
    // signals.
    const requestedSlug = this.resolveRequestedTenantSlug(req);
    const claimedTenantId = nonEmpty(claims.capiro_tenant_id);
    const claimedTenantSlug = nonEmpty(claims.capiro_tenant_slug);
    const claimedOrgId = nonEmpty(claims.org_id);

    // Step 3, resolve membership using RLS bypass. The lookup is not
    // tenant-scoped (we are still resolving the tenant), so it MUST run
    // through the system path.
    const ctx = await this.prisma.withSystem(async (tx) => {
      let user = await tx.user.findUnique({ where: { clerkUserId: claims.sub } });
      if (!user) {
        // First-time authenticated request from this Clerk user. The webhook is
        // the canonical source of users, but a slow (or, as in the 2026-05
        // webhook-routing outage, undelivered) webhook must not block a user
        // whose verified Clerk JWT already proves their identity.
        //
        // A row may already exist for this email — e.g. created by an earlier
        // flow with a different/placeholder clerkUserId, or by an out-of-order
        // webhook. Adopt it and bind it to this verified Clerk identity rather
        // than INSERTing a duplicate, which would violate the unique email
        // constraint and 500 every request. Verified-JWT email is authoritative.
        const email = claims.email ?? `${claims.sub}@unknown.invalid`;
        const existingByEmail = await tx.user.findUnique({ where: { email } });
        if (existingByEmail) {
          user = await tx.user.update({
            where: { id: existingByEmail.id },
            data: { clerkUserId: claims.sub },
          });
        } else {
          user = await tx.user.create({
            data: {
              clerkUserId: claims.sub,
              email,
            },
          });
        }
      }

      let memberships = await tx.tenantMembership.findMany({
        where: { userId: user.id, status: 'active' },
        include: { tenant: true },
      });

      // Match by every hint we have, in preference order. The JWT-claim
      // matches are the fast path: if the Clerk JWT template populated
      // capiro_tenant_id, we trust it (after the org_id cross-check below).
      let chosen: MembershipWithTenant | undefined =
        memberships.find((m) => claimedTenantId && m.tenantId === claimedTenantId) ??
        memberships.find((m) => claimedOrgId && m.tenant.clerkOrgId === claimedOrgId) ??
        memberships.find(
          (m) => claimedTenantSlug && m.tenant.slug === claimedTenantSlug.toLowerCase(),
        ) ??
        memberships.find((m) => requestedSlug && m.tenant.slug === requestedSlug) ??
        // Sole-membership fallback only when no signal at all was supplied.
        (memberships.length === 1 &&
        !claimedTenantId &&
        !claimedOrgId &&
        !claimedTenantSlug &&
        !requestedSlug
          ? memberships[0]
          : undefined);

      // Self-heal. The local tenant_memberships table is a MIRROR of Clerk org
      // memberships, populated asynchronously by the Clerk webhook. If that
      // mirror is missing the row but the cryptographically-verified Clerk JWT
      // asserts an active org membership (org_id claim), provision the row from
      // the trusted claims instead of locking the user out. This is the same
      // trust model the webhook uses (Clerk is the source of truth for org
      // membership); selfHealMembership() never grants access to a tenant the
      // JWT does not already prove membership in, and it refuses to resurrect a
      // membership that was explicitly removed/suspended.
      if (!chosen && claimedOrgId) {
        const healed = await this.selfHealMembership(tx, user.id, {
          claimedOrgId,
          claimedTenantId,
          claimedTenantSlug,
          orgRole: nonEmpty(claims.org_role) ?? nonEmpty(claims.capiro_org_role),
        });
        if (healed) {
          memberships = [...memberships, healed];
          chosen = healed;
          this.logger.warn(
            `Self-healed missing local membership for user ${user.id} in tenant ` +
              `${healed.tenantId} (role ${healed.role}) from a verified Clerk JWT; ` +
              `the webhook-populated mirror was stale.`,
          );
        }
      }

      if (memberships.length === 0) {
        throw new ForbiddenException('User has no active tenant memberships');
      }

      if (!chosen) {
        throw new ForbiddenException(
          'No matching tenant for the supplied identifier, re-auth required',
        );
      }

      // Step 4, integrity cross-checks. If the JWT and the resolved tenant
      // disagree on any identifier, force re-auth. Each branch covers a
      // different way an attacker could try to pivot tenants.
      if (claimedTenantId && chosen.tenantId !== claimedTenantId) {
        throw new ForbiddenException('Tenant claim mismatch, re-auth required');
      }
      if (claimedOrgId && chosen.tenant.clerkOrgId !== claimedOrgId) {
        throw new ForbiddenException('Org claim mismatch, re-auth required');
      }
      if (
        claimedTenantSlug &&
        chosen.tenant.slug.toLowerCase() !== claimedTenantSlug.toLowerCase()
      ) {
        throw new ForbiddenException('Tenant slug claim mismatch, re-auth required');
      }
      if (requestedSlug && chosen.tenant.slug !== requestedSlug) {
        throw new ForbiddenException('Subdomain/header tenant mismatch, re-auth required');
      }

      // Best-effort last_seen_at update, do not fail the request on error.
      await tx.user
        .update({ where: { id: user.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);

      // Impersonation override (capiro_admin only). If the caller is a
      // capiro_admin AND has an active session AND the request carries the
      // x-capiro-impersonate-tenant header, swap the tenant context to the
      // impersonated tenant. Every request executed under impersonation is
      // attributed to the actor (audit_logs.actor_user_id) so reads/writes
      // are traceable.
      const wantsImpersonate = req.header('x-capiro-impersonate-tenant')?.trim().toLowerCase();
      if (wantsImpersonate && chosen.role === 'capiro_admin') {
        const session = await tx.impersonationSession.findFirst({
          where: { actorUserId: user.id, endedAt: null, expiresAt: { gt: new Date() } },
          include: { tenant: true },
        });
        if (!session) {
          throw new ForbiddenException(
            'No active impersonation session, start one via /capiro-admin/impersonate',
          );
        }
        if (session.tenant.slug.toLowerCase() !== wantsImpersonate) {
          throw new ForbiddenException(
            `Impersonation session is for tenant ${session.tenant.slug}, header asks for ${wantsImpersonate}`,
          );
        }
        const context: TenantContext = {
          tenantId: session.tenantId,
          tenantSlug: session.tenant.slug,
          userId: user.id,
          clerkUserId: user.clerkUserId,
          role: 'capiro_admin', // role stays, capiro_admin acting as
        };
        return context;
      }

      const context: TenantContext = {
        tenantId: chosen.tenantId,
        tenantSlug: chosen.tenant.slug,
        userId: user.id,
        clerkUserId: user.clerkUserId,
        role: chosen.role as TenantRole,
      };
      return context;
    });

    // Step 4, propagate via AsyncLocalStorage AND req object. ALS lets
    // services pull the context without prop drilling; req.tenantContext is
    // for the @CurrentTenant() decorator and direct controller access.
    (req as Request & { tenantContext?: TenantContext }).tenantContext = ctx;
    this.store.run(ctx, () => next());
  }

  /**
   * Provision a local tenant_membership from a verified Clerk JWT when the
   * webhook-populated mirror is missing it. Returns the membership (with its
   * tenant) to use, or null if it cannot / must not be provisioned.
   *
   * Safety rules (this is an authorization path — fail closed):
   *   - The tenant is resolved by `clerk_org_id === org_id`, and org_id is a
   *     verified JWT claim, so we only ever provision a tenant the JWT already
   *     proves the user is a Clerk member of.
   *   - If the JWT also carries capiro_tenant_id / capiro_tenant_slug, they
   *     MUST agree with the resolved tenant (the same integrity checks the
   *     caller applies post-resolution), otherwise we bail.
   *   - The tenant must be active.
   *   - A pre-existing non-active membership (removed/suspended) is NOT
   *     resurrected: offboarding stays sticky and must be redone via the normal
   *     invite flow.
   */
  private async selfHealMembership(
    tx: SystemTx,
    userId: string,
    hints: {
      claimedOrgId: string;
      claimedTenantId?: string;
      claimedTenantSlug?: string;
      orgRole?: string;
    },
  ): Promise<MembershipWithTenant | null> {
    const tenant = await tx.tenant.findUnique({ where: { clerkOrgId: hints.claimedOrgId } });
    if (!tenant || tenant.status !== 'active') {
      return null;
    }
    if (hints.claimedTenantId && tenant.id !== hints.claimedTenantId) {
      return null;
    }
    if (
      hints.claimedTenantSlug &&
      tenant.slug.toLowerCase() !== hints.claimedTenantSlug.toLowerCase()
    ) {
      return null;
    }

    const existing = await tx.tenantMembership.findUnique({
      where: { tenantId_userId: { tenantId: tenant.id, userId } },
      include: { tenant: true },
    });
    if (existing) {
      // A row exists but was not in the active set (removed/suspended). Do not
      // silently re-grant access; require an explicit re-invite.
      return existing.status === 'active' ? existing : null;
    }

    // Mirror the webhook's role derivation exactly, keyed on the DB tenant slug
    // (authoritative) rather than the JWT's org_slug claim.
    const role = mapClerkRoleToCapiro(tenant.slug, hints.orgRole ?? 'org:member');
    return tx.tenantMembership.create({
      data: {
        tenantId: tenant.id,
        userId,
        role,
        status: 'active',
        joinedAt: new Date(),
      },
      include: { tenant: true },
    });
  }

  private resolveRequestedTenantSlug(req: Request): string | undefined {
    const headerVal = req.header(TENANT_HEADER);
    if (headerVal) return headerVal.trim().toLowerCase();

    const host = req.hostname; // e.g. acmelobby.app.capiro.ai
    const parts = host.split('.');
    // {slug}.app.capiro.ai, only treat as a tenant slug when the shape AND
    // TLD match. Strict matching prevents a malicious host header from
    // injecting an arbitrary slug via a lookalike domain.
    if (parts.length === 4 && parts[1] === 'app' && parts[2] === 'capiro' && parts[3] === 'ai') {
      return parts[0]?.toLowerCase();
    }
    return undefined;
  }
}

// Clerk's JWT template emits empty strings for `{{org.*}}` placeholders when
// the user has no active org. We treat empty as "no signal" rather than
// matching a tenant whose slug is literally "".
function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function isBypassPath(
  bypassPath: string,
  path: string,
  originalUrl: string,
  baseUrl: string,
): boolean {
  return (
    path === bypassPath ||
    originalUrl === bypassPath ||
    path.startsWith(`${bypassPath}/`) ||
    originalUrl.startsWith(`${bypassPath}/`) ||
    originalUrl.startsWith(`${bypassPath}?`) ||
    `${baseUrl}${path}` === bypassPath
  );
}
