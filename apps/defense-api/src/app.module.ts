import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from '@capiro/auth';
import { loadDefenseConfig } from './config/defense-config.js';
import { HealthModule } from './health/health.module.js';
import { InternalAuthModule } from './internal-auth/internal-auth.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { RequestContextModule } from './request-context/request-context.module.js';
import { OrgTenantResolverModule } from './auth/org-tenant-resolver.module.js';
import { JsonLogger } from './observability/json-logger.js';
import { ProgramElementsModule } from './program-elements/program-elements.module.js';
import { Phase17RuntimeModule } from './runtime/phase1-7-runtime.module.js';
import { BudgetLifecycleModule } from './budget-lifecycle/budget-lifecycle.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [() => ({ defense: loadDefenseConfig() })],
    }),
    PrismaModule,
    OrgTenantResolverModule,
    AuthModule,
    RequestContextModule,
    InternalAuthModule,
    HealthModule,
    // Session 3: full Program Elements surface registered dark. No production
    // traffic is routed here until the later shadow/canary/cutover sessions.
    ProgramElementsModule,
    // Session 4, dark only: no controllers, schedules, parser workers, promotion
    // execution, snapshot activation or production ownership change are registered
    // here. Layered ALONGSIDE Session 3's accepted route surface, not in place of it.
    Phase17RuntimeModule,
    // Session 7, dark only: annual cycle controller + lifecycle watcher control
    // plane. No controller, route, schedule, EventBridge watcher, promotion
    // executor or snapshot activator is registered here.
    BudgetLifecycleModule,
  ],
  providers: [JsonLogger],
})
export class AppModule {}
