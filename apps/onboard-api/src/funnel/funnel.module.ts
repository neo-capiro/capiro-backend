import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { EmailModule } from '../email/email.module.js';
import { LegalModule } from '../legal/legal.module.js';
import { FunnelController } from './funnel.controller.js';
import { FunnelService } from './funnel.service.js';
import { ProvisioningService } from './provisioning.service.js';

/**
 * Flow-1 funnel (plan §5 Phase 3): the registered → provisioned state machine
 * on OnboardSession, Stripe method-on-file / subscription creation (via the
 * shared StripeClient — onboard-api stays the single Stripe writer), legal
 * consents, and the idempotent provisioning bridge into apps/api.
 */
@Module({
  imports: [BillingModule, EmailModule, LegalModule],
  controllers: [FunnelController],
  providers: [FunnelService, ProvisioningService],
})
export class FunnelModule {}
