import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createParamDecorator, InternalServerErrorException } from '@nestjs/common';
import type { Request } from 'express';
import { ClerkService, type ClerkSessionClaims } from '@capiro/auth';
import { PrismaService } from '../prisma/prisma.service.js';

/** Reserved Clerk org slug for Capiro internal staff (mirrors apps/api). */
export const CAPIRO_INTERNAL_SLUG = 'capiro-internal';

/** Resolved billing actor attached to billing routes. */
export interface BillingActor {
  tenantId: string;
  tenantSlug: string;
  clerkUserId: string;
  userId: string | null;
  email: string | null;
  /** Cross-tenant Capiro staff (capiro-internal org admins). */
  capiroAdmin: boolean;
}

/**
 * Gate for billing-mutating routes (checkout / portal / upgrades). Permission
 * model (onboarding v1, Ninja decision Q6/Q8): billing is visible and
 * purchasable ONLY by
 *   • `capiro_admin` (admin of the capiro-internal Clerk org), or
 *   • a tenant `user_admin` whose membership carries `billing_admin = true`
 *     (the Gherkin "Super Admin").
 *
 * Self-contained (verify → resolve tenant → membership check) so it composes
 * with no other guard and never modifies the change-controlled @capiro/auth
 * files. Membership lookups run withSystem because tenant_memberships is
 * RLS'd and the request context is what we're establishing.
 */
@Injectable()
export class BillingActorGuard implements CanActivate {
  private readonly logger = new Logger(BillingActorGuard.name);

  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { billingActor?: BillingActor }>();

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

    const orgSlug = claims.org_slug ?? null;
    const orgRole = (claims.org_role ?? claims.capiro_org_role ?? '').toLowerCase();
    const isOrgAdmin = orgRole.includes('admin');
    const capiroAdmin = orgSlug === CAPIRO_INTERNAL_SLUG && isOrgAdmin;

    // Resolve the tenant UUID from the verified claims (template claim is the
    // UUID; org_id fallback is the Clerk org id needing a lookup).
    const rawTenant = claims.capiro_tenant_id?.trim() || claims.org_id?.trim();
    if (!rawTenant) throw new ForbiddenException('No tenant in token');

    const resolved = await this.prisma.withSystem(async (tx) => {
      const tenant = rawTenant.startsWith('org_')
        ? await tx.tenant.findUnique({
            where: { clerkOrgId: rawTenant },
            select: { id: true, slug: true },
          })
        : await tx.tenant.findUnique({
            where: { id: rawTenant },
            select: { id: true, slug: true },
          });
      if (!tenant) return null;
      const user = await tx.user.findUnique({
        where: { clerkUserId: claims.sub! },
        select: { id: true, email: true },
      });
      const membership = user
        ? await tx.tenantMembership.findUnique({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            select: { role: true, status: true, billingAdmin: true },
          })
        : null;
      return { tenant, user, membership };
    });
    if (!resolved) throw new ForbiddenException('No tenant for org');

    const { tenant, user, membership } = resolved;
    const isBillingAdmin =
      membership?.status === 'active' &&
      membership.role === 'user_admin' &&
      membership.billingAdmin === true;

    if (!capiroAdmin && !isBillingAdmin) {
      // Gherkin: billing is entirely hidden from non-billing-admins — the
      // 403 body deliberately carries no billing detail.
      throw new ForbiddenException('Billing is managed by your billing admin.');
    }

    req.billingActor = {
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      clerkUserId: claims.sub,
      userId: user?.id ?? null,
      email: user?.email ?? null,
      capiroAdmin,
    };
    return true;
  }
}

/** Injects the {@link BillingActor} attached by {@link BillingActorGuard}. */
export const CurrentBillingActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): BillingActor => {
    const req = ctx.switchToHttp().getRequest();
    if (!req.billingActor) {
      throw new InternalServerErrorException('CurrentBillingActor used without BillingActorGuard');
    }
    return req.billingActor as BillingActor;
  },
);
