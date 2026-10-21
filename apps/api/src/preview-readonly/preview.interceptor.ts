import {
  ForbiddenException, HttpException, Inject, Injectable, UnauthorizedException, ServiceUnavailableException,
  type CallHandler, type ExecutionContext, type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { from, lastValueFrom } from 'rxjs';
import type { TenantContext } from '@capiro/shared';
import { ClerkService, type ClerkSessionClaims } from '../auth/clerk.service.js';
import { CAPIRO_INTERNAL_SLUG, mapClerkRoleToCapiro } from '../auth/clerk-role.util.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TenantContextStore } from '../tenant/tenant-context.store.js';
import { PREVIEW_CONFIG, type PreviewConfig } from './preview.config.js';

@Injectable()
export class PreviewReadOnlyInterceptor implements NestInterceptor {
  constructor(
    private readonly clerk: ClerkService,
    private readonly prisma: PrismaService,
    private readonly store: TenantContextStore,
    @Inject(PREVIEW_CONFIG) private readonly config: PreviewConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const req = context.switchToHttp().getRequest<Request & { tenantContext?: TenantContext }>();
    return from(this.read(req, next).catch((error: unknown) => {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException('Preview read unavailable');
    }));
  }

  private async read(req: Request & { tenantContext?: TenantContext }, next: CallHandler) {
    if ('x-capiro-impersonate-tenant' in req.headers) throw new ForbiddenException('Impersonation unavailable');
    const auth = req.headers.authorization;
    if (!auth?.toLowerCase().startsWith('bearer ') || !auth.slice(7).trim()) {
      throw new UnauthorizedException('Missing bearer token');
    }
    let claims: ClerkSessionClaims;
    try { claims = await this.clerk.verifySessionToken(auth.slice(7).trim()); }
    catch { throw new UnauthorizedException('Invalid session token'); }
    const actor = claims as ClerkSessionClaims & { act?: unknown; actor?: unknown };
    if (actor.act != null || actor.actor != null) throw new ForbiddenException('Impersonation unavailable');
    const { PREVIEW_TENANT_ID: tenantId, PREVIEW_CLERK_ORG_ID: orgId } = this.config.preview;
    const validClaims = () => {
      if (!claims.sub || !Number.isSafeInteger(claims.exp) || claims.exp! * 1000 <= Date.now() ||
          claims.iss !== this.config.preview.CLERK_JWT_ISSUER || claims.org_id !== orgId ||
          (claims.capiro_tenant_id != null && claims.capiro_tenant_id !== '' && claims.capiro_tenant_id !== tenantId) ||
          [claims.capiro_tenant_slug, claims.org_slug].some((slug) => slug != null && slug !== '' && slug !== CAPIRO_INTERNAL_SLUG) ||
          (req.headers['x-capiro-tenant'] != null && req.headers['x-capiro-tenant'] !== CAPIRO_INTERNAL_SLUG)) {
        throw new ForbiddenException('Preview authority unavailable');
      }
    };
    validClaims();
    const assertSession = async () => {
      const session = await this.clerk.assertActiveApplicationAuthoritySession(claims);
      if (session.actor != null) throw new ForbiddenException('Impersonation unavailable');
      return session;
    };
    await assertSession();
    return this.prisma.withPreviewReadOnly(tenantId, async (tx) => {
      // Resolve only exact existing identity: never email adoption or provisioning.
      const resolve = async () => {
        const user = await tx.user.findUnique({ where: { clerkUserId: claims.sub }, select: { id: true, clerkUserId: true } });
        if (!user || user.clerkUserId !== claims.sub) throw new ForbiddenException('Preview authority unavailable');
        const membership = await tx.tenantMembership.findUnique({
          where: { tenantId_userId: { tenantId, userId: user.id } },
          select: { id: true, userId: true, tenantId: true, status: true, role: true, updatedAt: true,
            tenant: { select: { id: true, slug: true, status: true, clerkOrgId: true } } },
        });
        const roleClaim = claims.org_role ?? claims.capiro_org_role;
        if (!roleClaim || (claims.org_role && claims.capiro_org_role &&
              mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, claims.org_role) !== mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, claims.capiro_org_role)) ||
            !membership || membership.userId !== user.id || membership.tenantId !== tenantId || membership.status !== 'active' ||
            membership.tenant.id !== tenantId || membership.tenant.status !== 'active' ||
            membership.tenant.slug !== CAPIRO_INTERNAL_SLUG || membership.tenant.clerkOrgId !== orgId ||
            membership.role !== mapClerkRoleToCapiro(CAPIRO_INTERNAL_SLUG, roleClaim)) {
          throw new ForbiddenException('Preview authority unavailable');
        }
        return { user, membership };
      };
      const before = await resolve();
      const ctx: TenantContext = {
        tenantId, tenantSlug: CAPIRO_INTERNAL_SLUG, userId: before.user.id,
        clerkUserId: before.user.clerkUserId, role: before.membership.role,
      };
      req.tenantContext = ctx;
      // Subscribe within ALS. Buffer the response until transaction commit;
      // no response is sent if the final authority read or commit fails.
      const result = await this.store.run(ctx, () => lastValueFrom(next.handle()));
      validClaims();
      await assertSession();
      validClaims();
      const after = await resolve();
      if (after.user.id !== before.user.id || after.membership.id !== before.membership.id ||
          after.membership.updatedAt.getTime() !== before.membership.updatedAt.getTime()) {
        throw new ForbiddenException('Preview authority changed');
      }
      return result;
    });
  }
}
