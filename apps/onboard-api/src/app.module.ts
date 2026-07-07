import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { OnboardAuthModule } from './auth/onboard-auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { FunnelModule } from './funnel/funnel.module.js';
import { HealthModule } from './health/health.module.js';
import { ItAdminModule } from './it-admin/it-admin.module.js';
import { LifecycleModule } from './lifecycle/lifecycle.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PublicModule } from './public/public.module.js';
import { SetupModule } from './setup/setup.module.js';

/**
 * Onboard API root module.
 *
 * The self-service onboarding + billing service:
 *   • Flow 1 funnel state machine (registration → provisioning),
 *   • Stripe billing (single writer; moved from apps/api),
 *   • Flow 2A external setup dashboard + IT-admin grant path,
 *   • trial/billing lifecycle crons (via the task-runner entrypoint).
 * Feature modules register here as the phases land.
 *
 * Global rate limit (plan §5 Phase 8 abuse hardening, pulled forward with the
 * funnel): 20 req/s burst + 300 req/min sustained per client, enforced on
 * every route by the APP_GUARD ThrottlerGuard.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'long', ttl: 60_000, limit: 300 },
    ]),
    PrismaModule,
    OnboardAuthModule,
    HealthModule,
    PublicModule,
    BillingModule,
    FunnelModule,
    SetupModule,
    ItAdminModule,
    LifecycleModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
