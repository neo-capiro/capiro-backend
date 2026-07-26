import { Global, Module } from '@nestjs/common';
import { ClerkService } from './clerk.service.js';
import { OrgTenantResolverService } from './org-tenant-resolver.service.js';
import { TenantGuard } from './tenant.guard.js';

@Global()
@Module({
  providers: [ClerkService, OrgTenantResolverService, TenantGuard],
  exports: [ClerkService, OrgTenantResolverService, TenantGuard],
})
export class AuthModule {}
