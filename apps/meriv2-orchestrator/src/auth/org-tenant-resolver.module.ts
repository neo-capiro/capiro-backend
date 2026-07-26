import { Global, Module } from '@nestjs/common';
import { ORG_TENANT_RESOLVER } from '@capiro/auth';
import { MeriTenantGuard } from './meri-tenant.guard.js';
import { PrismaOrgTenantResolver } from './org-tenant-resolver.provider.js';

/**
 * Supplies the canonical org->tenant + active-membership lookup that
 * @capiro/auth's TenantGuard REQUIRES.
 *
 * The guard injects this without @Optional() on purpose: an optional resolver
 * would fail OPEN, and a service that forgot to register the provider would
 * silently keep the old claim-only behaviour. Required means it fails to boot
 * instead. This module must therefore be imported by AppModule BEFORE anything
 * that uses TenantGuard.
 */
@Global()
@Module({
  providers: [{ provide: ORG_TENANT_RESOLVER, useClass: PrismaOrgTenantResolver }, MeriTenantGuard],
  exports: [ORG_TENANT_RESOLVER, MeriTenantGuard],
})
export class OrgTenantResolverModule {}
