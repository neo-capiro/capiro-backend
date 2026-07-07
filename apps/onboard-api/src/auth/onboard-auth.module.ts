import { Global, Module } from '@nestjs/common';
import { AuthModule } from '@capiro/auth';
import { ClerkUserGuard } from './clerk-user.guard.js';
import { TenantResolverService } from './tenant-resolver.service.js';

/**
 * Auth wiring for onboard-api.
 *
 * Re-exports @capiro/auth (ClerkService + TenantGuard for tenant-scoped
 * dashboard/billing routes) and adds:
 *   • ClerkUserGuard — org-less purchaser routes (the Flow-1 funnel),
 *   • TenantResolverService — org_id → tenant UUID normalization.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [ClerkUserGuard, TenantResolverService],
  exports: [AuthModule, ClerkUserGuard, TenantResolverService],
})
export class OnboardAuthModule {}
