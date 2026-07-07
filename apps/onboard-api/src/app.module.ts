import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { OnboardAuthModule } from './auth/onboard-auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PublicModule } from './public/public.module.js';

/**
 * Onboard API root module.
 *
 * The self-service onboarding + billing service:
 *   • Flow 1 funnel state machine (registration → provisioning),
 *   • Stripe billing (single writer; moved from apps/api),
 *   • Flow 2A external setup dashboard + IT-admin grant path,
 *   • trial/billing lifecycle crons (via the task-runner entrypoint).
 * Feature modules register here as the phases land.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true }),
    PrismaModule,
    OnboardAuthModule,
    HealthModule,
    PublicModule,
    BillingModule,
  ],
})
export class AppModule {}
