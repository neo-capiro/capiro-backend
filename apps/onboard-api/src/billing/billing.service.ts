import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Stripe from 'stripe';
import { type BillingStatus, MIN_CLIENT_SLOTS } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeClient } from './stripe.client.js';
import type { BillingActor } from '../auth/billing-actor.guard.js';

/**
 * Maps a Stripe subscription status to our coarser BillingStatus. We never map
 * to 'comped' — that is a manual, Capiro-set state that must not be clobbered
 * by webhook syncs (see syncSubscription's guard).
 */
export function mapStripeStatus(status: Stripe.Subscription.Status): BillingStatus {
  switch (status) {
    case 'active':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'canceled';
    case 'incomplete':
    case 'paused':
    default:
      return 'none';
  }
}

/**
 * Start of the current billing period for usage/allowance math. Aligns to the
 * Stripe period when known (monthly), else the first of the calendar month
 * (UTC). Day-aligned so it is a stable key for tenant_usage_meters.
 */
export function billingPeriodStart(currentPeriodEnd: Date | null | undefined): Date {
  if (currentPeriodEnd) {
    const start = new Date(currentPeriodEnd);
    start.setUTCMonth(start.getUTCMonth() - 1);
    start.setUTCHours(0, 0, 0, 0);
    return start;
  }
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Price-lock horizon (Ninja decision Q2): $200/slot locked for 12 months. */
export const PRICE_LOCK_MONTHS = 12;

/**
 * Stripe billing core — ported from apps/api (PR #stripe-dormant, 2026-06-14)
 * and now the SINGLE Stripe writer platform-wide. apps/api keeps read-only
 * billing views (summary / admin list); every mutation and webhook lives here.
 *
 * All writes to the RLS'd `tenants` table run withSystem (webhook/cron paths
 * carry no tenant GUC) and are audited in onboard_billing_event.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly config: ConfigService,
  ) {}

  private get slotsPriceId(): string {
    const id = this.config.get<string>('STRIPE_PRICE_SLOTS');
    if (!id) throw new BadRequestException('Slot price is not configured (STRIPE_PRICE_SLOTS).');
    return id;
  }

  private get overagePriceId(): string | undefined {
    return this.config.get<string>('STRIPE_PRICE_OVERAGE') || undefined;
  }

  private get returnBase(): string {
    return this.config.get<string>('BILLING_RETURN_URL') ?? 'https://app.capiro.ai';
  }

  // ---------------------------------------------------------------------------
  // Checkout (in-app subscribe + add slots — the 1.6b-reuse upgrade path)
  // ---------------------------------------------------------------------------

  /**
   * Create a Stripe Checkout Session for a subscription with `quantity` client
   * slots (clamped to the minimum) plus the metered LLM-overage line. Returns
   * the hosted Checkout URL. Payment methods are NOT pinned here — they come
   * from the dashboard's configured methods.
   */
  async createCheckoutSession(
    actor: BillingActor,
    opts: { quantity: number; promoCode?: string },
  ): Promise<{ url: string }> {
    const stripe = this.stripe.require();
    const quantity = Math.max(MIN_CLIENT_SLOTS, Math.floor(opts.quantity || 0));

    const customerId = await this.ensureCustomer(actor, stripe);

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      { price: this.slotsPriceId, quantity },
    ];
    if (this.overagePriceId) {
      // Metered prices carry no quantity.
      lineItems.push({ price: this.overagePriceId });
    }

    // Promotion code: if the caller supplied one, resolve it to a promotion-code
    // id and apply it directly (Checkout forbids combining an explicit discount
    // with allow_promotion_codes). Otherwise let the customer type one in.
    let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
    let allowPromotionCodes: boolean | undefined = true;
    if (opts.promoCode?.trim()) {
      const code = opts.promoCode.trim();
      const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      const promo = found.data[0];
      if (!promo) throw new BadRequestException(`Promo code "${code}" is not valid.`);
      discounts = [{ promotion_code: promo.id }];
      allowPromotionCodes = undefined;
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      client_reference_id: actor.tenantId,
      line_items: lineItems,
      discounts,
      allow_promotion_codes: allowPromotionCodes,
      subscription_data: {
        metadata: { tenantId: actor.tenantId, tenantSlug: actor.tenantSlug },
      },
      metadata: { tenantId: actor.tenantId, tenantSlug: actor.tenantSlug },
      success_url: `${this.returnBase}/onboarding/subscribe?status=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.returnBase}/onboarding/subscribe?status=cancelled`,
    });

    if (!session.url) throw new BadRequestException('Stripe did not return a Checkout URL.');
    await this.audit(actor.tenantId, 'checkout_session_created', {
      quantity,
      actor: actor.clerkUserId,
    });
    return { url: session.url };
  }

  /**
   * Create a Stripe Customer Portal session (manage card, change slot quantity,
   * view invoices). Surfaced under Settings → Billing and the slot-limit CTA.
   */
  async createPortalSession(actor: BillingActor): Promise<{ url: string }> {
    const stripe = this.stripe.require();
    const tenant = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: actor.tenantId },
        select: { stripeCustomerId: true },
      }),
    );
    if (!tenant?.stripeCustomerId) {
      throw new BadRequestException('No billing account yet — subscribe first.');
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: tenant.stripeCustomerId,
      return_url: `${this.returnBase}/settings/billing`,
    });
    return { url: session.url };
  }

  /** Find-or-create the tenant's Stripe customer, persisting the id. */
  async ensureCustomer(actor: BillingActor, stripe: Stripe): Promise<string> {
    const tenant = await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: actor.tenantId },
        select: { name: true, slug: true, stripeCustomerId: true },
      }),
    );
    if (tenant?.stripeCustomerId) return tenant.stripeCustomerId;

    const customer = await stripe.customers.create({
      name: tenant?.name,
      email: actor.email ?? undefined,
      metadata: { tenantId: actor.tenantId, tenantSlug: actor.tenantSlug },
    });
    await this.prisma.withTenant(actor.tenantId, (tx) =>
      tx.tenant.update({
        where: { id: actor.tenantId },
        data: { stripeCustomerId: customer.id },
      }),
    );
    return customer.id;
  }

  // ---------------------------------------------------------------------------
  // Webhook sync (source of truth = Stripe)
  // ---------------------------------------------------------------------------

  /** Resolve + sync the subscription referenced by a completed Checkout Session. */
  async handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
    const stripe = this.stripe.require();
    const subId =
      typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
    if (!subId) {
      this.logger.warn(`checkout.session.completed ${session.id} had no subscription`);
      return;
    }
    const sub = await stripe.subscriptions.retrieve(subId);
    await this.syncSubscription(sub);
  }

  /**
   * Write subscription state onto the owning tenant. Tenant is located by
   * Stripe customer id, falling back to the tenantId we stamp in metadata.
   * Never downgrades a 'comped' tenant. On the FIRST transition into a paying
   * status, stamps price_lock_expires_at (12-month $200 lock, decision Q2).
   */
  async syncSubscription(sub: Stripe.Subscription): Promise<void> {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const metaTenantId = (sub.metadata?.tenantId as string | undefined) ?? undefined;

    const slotsItem = sub.items.data.find(
      (i) => i.price?.id === this.config.get<string>('STRIPE_PRICE_SLOTS'),
    );
    const slots = slotsItem?.quantity ?? undefined;
    const periodEndUnix =
      (sub as unknown as { current_period_end?: number }).current_period_end ??
      (sub.items.data[0] as unknown as { current_period_end?: number } | undefined)
        ?.current_period_end;
    const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000) : null;
    const mapped = mapStripeStatus(sub.status);

    await this.prisma.withSystem(async (tx) => {
      const tenant =
        (await tx.tenant.findFirst({ where: { stripeCustomerId: customerId } })) ??
        (metaTenantId ? await tx.tenant.findUnique({ where: { id: metaTenantId } }) : null);
      if (!tenant) {
        this.logger.warn(
          `syncSubscription: no tenant for customer ${customerId} / meta ${metaTenantId ?? '∅'}`,
        );
        return;
      }
      // Don't let a webhook clobber a manually comped tenant.
      const nextStatus = tenant.billingStatus === 'comped' ? 'comped' : mapped;
      const enteringPaid =
        (nextStatus === 'active' || nextStatus === 'trialing') && !tenant.priceLockExpiresAt;
      const lockExpiry = enteringPaid
        ? new Date(new Date().setUTCMonth(new Date().getUTCMonth() + PRICE_LOCK_MONTHS))
        : undefined;
      await tx.tenant.update({
        where: { id: tenant.id },
        data: {
          stripeCustomerId: customerId,
          stripeSubscriptionId: sub.status === 'canceled' ? null : sub.id,
          billingStatus: nextStatus,
          ...(slots != null ? { clientSlots: slots } : {}),
          ...(lockExpiry ? { priceLockExpiresAt: lockExpiry } : {}),
          ...(nextStatus === 'canceled' && tenant.billingStatus !== 'canceled'
            ? { canceledAt: new Date() }
            : {}),
          currentPeriodEnd,
        },
      });
      await tx.onboardBillingEvent.create({
        data: {
          tenantId: tenant.id,
          type: 'subscription_synced',
          data: {
            subscriptionId: sub.id,
            stripeStatus: sub.status,
            mappedStatus: nextStatus,
            slots: slots ?? null,
          },
        },
      });
      this.logger.log(
        `Synced subscription ${sub.id} → tenant ${tenant.slug}: status=${nextStatus} slots=${slots ?? 'unchanged'}`,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Capiro-admin: comp toggle (moved from apps/api — writes live here now)
  // ---------------------------------------------------------------------------

  /**
   * Comp (or un-comp) a tenant. Comped tenants bypass slot enforcement and LLM
   * overage; un-comping returns them to 'none' (they must subscribe).
   */
  async setComped(
    tenantId: string,
    comped: boolean,
    actor?: string,
  ): Promise<{ status: BillingStatus }> {
    const status: BillingStatus = comped ? 'comped' : 'none';
    await this.prisma.withSystem(async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        // Comping is the staff bypass — it must take effect IMMEDIATELY, so a
        // past-due lockout is cleared here rather than waiting for the next
        // daily lifecycle run (which only clears non-past_due tenants anyway).
        data: { billingStatus: status, ...(comped ? { lockedAt: null } : {}) },
      });
      await tx.onboardBillingEvent.create({
        data: { tenantId, type: 'comp_toggled', data: { comped }, actor: actor ?? null },
      });
    });
    this.logger.log(`Tenant ${tenantId} billing set to ${status}`);
    return { status };
  }

  /** Append-only billing audit row (SOC 2 evidence + debugging). */
  private async audit(tenantId: string, type: string, data: object): Promise<void> {
    try {
      await this.prisma.onboardBillingEvent.create({
        data: { tenantId, type, data: data as never },
      });
    } catch (err) {
      this.logger.warn(`billing audit write failed (${type}): ${(err as Error).message}`);
    }
  }
}
