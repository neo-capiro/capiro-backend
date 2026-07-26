import { Global, Module } from '@nestjs/common';
import { AuthModule, ORG_TENANT_RESOLVER } from '@capiro/auth';
import { ClerkUserGuard } from './clerk-user.guard.js';
import { PrismaOrgTenantResolver } from './org-tenant-resolver.provider.js';
import { TenantResolverService } from './tenant-resolver.service.js';

/**
 * Auth wiring for onboard-api.
 *
 * Re-exports @capiro/auth (ClerkService + TenantGuard for tenant-scoped
 * dashboard/billing routes) and adds:
 *   • ClerkUserGuard — org-less purchaser routes (the Flow-1 funnel),
 *   • ORG_TENANT_RESOLVER — the canonical org->tenant + active-membership
 *     lookup that @capiro/auth's TenantGuard now REQUIRES. Without this
 *     provider the service does not boot, which is deliberate: an optional
 *     resolver would fail OPEN and silently keep the old claim-only behaviour.
 *   • TenantResolverService — legacy org_id → tenant UUID normalization,
 *     retained for the service-layer call sites that still use it. Now largely
 *     redundant: TenantGuard already puts a canonical UUID in ctx.tenantId, so
 *     its `startsWith('org_')` branch should no longer fire.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    ClerkUserGuard,
    TenantResolverService,
    { provide: ORG_TENANT_RESOLVER, useClass: PrismaOrgTenantResolver },
  ],
  exports: [AuthModule, ClerkUserGuard, TenantResolverService, ORG_TENANT_RESOLVER],
})
export class OnboardAuthModule {}
