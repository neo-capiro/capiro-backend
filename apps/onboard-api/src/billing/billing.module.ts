import { Module } from '@nestjs/common';
import { StripeClient } from './stripe.client.js';
import { BillingService } from './billing.service.js';
import { BillingAdminController, BillingController } from './billing.controller.js';
import { StripeWebhookService } from './stripe-webhook.service.js';
import { StripeWebhookController } from './stripe-webhook.controller.js';
import { AiUsageReaderService } from './ai-usage-reader.service.js';
import { BillingOverageService } from './billing-overage.service.js';
import { BillingActorGuard } from '../auth/billing-actor.guard.js';
import { CapiroAdminGuard } from '../auth/capiro-admin.guard.js';

/**
 * Stripe-direct billing, moved wholesale from apps/api (onboarding v1):
 * Checkout + Customer Portal + webhook sync + comp toggle + the LLM-overage
 * metering job. onboard-api is the single Stripe writer; apps/api keeps
 * read-only billing views.
 */
@Module({
  controllers: [BillingController, BillingAdminController, StripeWebhookController],
  providers: [
    StripeClient,
    BillingService,
    StripeWebhookService,
    AiUsageReaderService,
    BillingOverageService,
    BillingActorGuard,
    CapiroAdminGuard,
  ],
  exports: [StripeClient, BillingService, BillingOverageService],
})
export class BillingModule {}
