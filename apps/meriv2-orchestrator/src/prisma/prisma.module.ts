import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Global so any feature module injects PrismaService without re-importing.
 * Mirrors apps/workspace, apps/api-strategy and apps/api.
 *
 * Added 2026-07-25. PrismaService was previously provided inside MeriModule,
 * which is NOT global — so anything registered outside MeriModule (such as the
 * ORG_TENANT_RESOLVER provider that @capiro/auth's TenantGuard now requires)
 * could not inject it, and naively re-providing it elsewhere would have created
 * a SECOND PrismaClient and a second connection pool against the same Aurora
 * cluster.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
