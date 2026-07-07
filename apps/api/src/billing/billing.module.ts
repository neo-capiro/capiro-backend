import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiUsageModule } from '../ai-usage/ai-usage.module.js';
import { BillingService } from './billing.service.js';
import { BillingController } from './billing.controller.js';
import { BillingAdminGuard } from './billing-admin.guard.js';

/**
 * READ-ONLY billing views (onboarding v1). The Stripe integration —
 * checkout, portal, webhooks, comp toggle, overage metering — moved to
 * apps/onboard-api (the single Stripe writer). This module keeps the summary/
 * state reads that power the paywall, trial banner, Settings → Billing, and
 * the capiro-admin Customers console.
 */
@Module({
  imports: [PrismaModule, AiUsageModule],
  controllers: [BillingController],
  providers: [BillingService, BillingAdminGuard],
  exports: [BillingService, BillingAdminGuard],
})
export class BillingModule {}
