import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { OrgTenantResolverModule } from './auth/org-tenant-resolver.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { FlagsModule } from './flags/flags.module.js';
import { StrategyModule } from './strategy/strategy.module.js';
import { FirmPhasesModule } from './firm-phases/firm-phases.module.js';
import { ReferenceModule } from './reference/reference.module.js';
import { MeriModule } from './meri/meri.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { ContextModule } from './context/context.module.js';

/**
 * Root module for the api-strategy service.
 *
 * G1: platform wiring (config, tenant-scoped Prisma, Clerk auth, health).
 * G2: per-tenant flag gating (FlagsModule) + read/manual-create feature
 * modules (strategies, firm-phases, reference-calendars). Node CRUD, versions,
 * and the Meri assistant arrive in G3/G5.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    // MUST precede AuthModule: the shared TenantGuard injects
    // ORG_TENANT_RESOLVER as a REQUIRED dependency (no @Optional(), which would
    // fail open). Missing it is a boot failure, by design.
    OrgTenantResolverModule,
    AuthModule,
    FlagsModule,
    HealthModule,
    StrategyModule,
    FirmPhasesModule,
    ReferenceModule,
    MeriModule,
    AgentsModule,
    ContextModule,
  ],
})
export class AppModule {}
