import { Global, Module } from '@nestjs/common';
import { ORG_TENANT_RESOLVER } from '@capiro/auth';
import { PrismaOrgTenantResolver } from './org-tenant-resolver.provider.js';

@Global()
@Module({
  providers: [
    {
      provide: ORG_TENANT_RESOLVER,
      useClass: PrismaOrgTenantResolver,
    },
  ],
  exports: [ORG_TENANT_RESOLVER],
})
export class OrgTenantResolverModule {}
