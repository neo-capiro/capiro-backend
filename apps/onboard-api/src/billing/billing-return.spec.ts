import type { ConfigService } from '@nestjs/config';
import type { BillingActor } from '../auth/billing-actor.guard.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StripeClient } from './stripe.client.js';
import { BillingService } from './billing.service.js';

jest.mock('@capiro/shared', () => ({ MIN_CLIENT_SLOTS: 10 }), { virtual: true });
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('./stripe.client.js', () => ({ StripeClient: class {} }));

const actor: BillingActor = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  tenantSlug: 'synthetic-billing',
  clerkUserId: 'user_synthetic',
  userId: null,
  email: null,
  capiroAdmin: false,
};

function fixture(returnBase?: string) {
  const tenantUpdate = jest.fn();
  const tenant = {
    findUnique: jest.fn().mockResolvedValue({ stripeCustomerId: 'cus_synthetic' }),
    update: tenantUpdate,
  };
  const prisma = {
    withTenant: jest.fn(
      async (_tenantId: string, operation: (tx: { tenant: typeof tenant }) => unknown) =>
        operation({ tenant }),
    ),
    onboardBillingEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const checkout = jest.fn().mockResolvedValue({ url: 'https://checkout.stripe.test/synthetic' });
  const portal = jest.fn().mockResolvedValue({ url: 'https://billing.stripe.test/synthetic' });
  const stripe = {
    checkout: { sessions: { create: checkout } },
    billingPortal: { sessions: { create: portal } },
  };
  const values: Record<string, string | undefined> = {
    BILLING_RETURN_URL: returnBase,
    STRIPE_PRICE_SLOTS: 'price_synthetic',
  };
  const config = { get: (key: string) => values[key] };
  const service = new BillingService(
    prisma as unknown as PrismaService,
    { require: () => stripe } as unknown as StripeClient,
    config as unknown as ConfigService,
  );
  return { service, checkout, portal, tenantUpdate, prisma };
}

describe('hosted billing returns to the authenticated billing page', () => {
  it('preserves checkout success/cancel indicators at the configured billing destination', async () => {
    const f = fixture('https://portfolio-preview.app.capiro.ai');
    await expect(f.service.createCheckoutSession(actor, { quantity: 10 })).resolves.toEqual({
      url: 'https://checkout.stripe.test/synthetic',
    });
    expect(f.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          'https://portfolio-preview.app.capiro.ai/settings/billing?status=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://portfolio-preview.app.capiro.ai/settings/billing?status=cancelled',
        customer: 'cus_synthetic',
        client_reference_id: actor.tenantId,
      }),
    );
    expect(f.tenantUpdate).not.toHaveBeenCalled();
    expect(f.prisma.onboardBillingEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'checkout_session_created' }),
      }),
    );
  });

  it('keeps the established default app origin when no override is configured', async () => {
    const f = fixture();
    await f.service.createCheckoutSession(actor, { quantity: 10 });
    expect(f.checkout).toHaveBeenCalledWith(
      expect.objectContaining({
        success_url:
          'https://app.capiro.ai/settings/billing?status=success&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://app.capiro.ai/settings/billing?status=cancelled',
      }),
    );
  });

  it('preserves the existing portal destination and does not infer entitlement', async () => {
    const f = fixture('https://portfolio-preview.app.capiro.ai');
    await f.service.createPortalSession(actor);
    expect(f.portal).toHaveBeenCalledWith({
      customer: 'cus_synthetic',
      return_url: 'https://portfolio-preview.app.capiro.ai/settings/billing',
    });
    expect(f.tenantUpdate).not.toHaveBeenCalled();
  });
});
