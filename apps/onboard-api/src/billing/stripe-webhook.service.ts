import { Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';

/**
 * Processes Stripe webhook events (ported from apps/api verbatim; the
 * endpoint moved to /onboard-api/webhooks/stripe). Idempotent: every event is
 * recorded in stripe_events keyed by the Stripe event id; re-deliveries are
 * skipped once processed.
 *
 * We do NOT dispatch inside the idempotency transaction, because the
 * downstream BillingService.syncSubscription opens its own withSystem
 * transaction (Prisma forbids nesting). Instead we claim the event, dispatch,
 * then mark processed. Dispatch is idempotent (it writes the subscription's
 * current state), so a crash between dispatch and the mark just results in a
 * harmless reprocess on Stripe's retry.
 */
@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  async handle(event: Stripe.Event): Promise<void> {
    const claimed = await this.prisma.withSystem(async (tx) => {
      const existing = await tx.stripeEvent.findUnique({ where: { eventId: event.id } });
      if (existing?.processedAt) return false;
      if (!existing) {
        await tx.stripeEvent.create({
          data: {
            eventId: event.id,
            eventType: event.type,
            payload: event as unknown as object,
          },
        });
      }
      return true;
    });
    if (!claimed) {
      this.logger.debug(`Skipping already-processed Stripe event ${event.id}`);
      return;
    }

    try {
      await this.dispatch(event);
      await this.prisma.withSystem((tx) =>
        tx.stripeEvent.update({
          where: { eventId: event.id },
          data: { processedAt: new Date(), error: null },
        }),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Failed to process Stripe event ${event.id} (${event.type}): ${message}`);
      await this.prisma.withSystem((tx) =>
        tx.stripeEvent.update({ where: { eventId: event.id }, data: { error: message } }),
      );
      throw err; // surface 500 → Stripe retries
    }
  }

  private async dispatch(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'checkout.session.completed':
        await this.billing.handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.billing.syncSubscription(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        // The accompanying customer.subscription.updated flips the tenant to
        // past_due; we just log the failure for visibility.
        this.logger.warn(`Invoice payment failed: ${(event.data.object as Stripe.Invoice).id}`);
        break;
      default:
        this.logger.debug(`Unhandled Stripe event type ${event.type}`);
    }
  }
}
