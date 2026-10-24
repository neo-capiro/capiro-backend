import { describe, expect, it, jest } from '@jest/globals';
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../ai-usage/ai-usage.service.js', () => ({ AiUsageService: class {} }));
import { BillingService } from './billing.service.js';

describe('Settings billing subscription identity', () => {
  it.each([
    { customer: null, subscription: null, expected: false },
    { customer: 'synthetic-customer', subscription: null, expected: false },
    { customer: 'synthetic-customer', subscription: 'synthetic-subscription', expected: true },
  ])(
    'reports subscription existence independently of customer creation: %j',
    async ({ customer, subscription, expected }) => {
      const tx = {
        tenant: {
          findUnique: jest.fn(async () => ({
            billingStatus: subscription ? 'active' : 'none',
            clientSlots: 10,
            stripeCustomerId: customer,
            stripeSubscriptionId: subscription,
            currentPeriodEnd: null,
          })),
        },
        client: { count: jest.fn(async () => 0) },
      };
      const withTenant = jest.fn(async (_id: string, action: (tx: unknown) => Promise<unknown>) =>
        action(tx),
      );
      const service = new BillingService(
        { withTenant } as never,
        { tenantSummaryByTenantId: async () => ({ totalCostUsd: 0 }) } as never,
        { get: () => true } as never,
      );
      const result = await service.getSummary({ tenantId: 'synthetic-tenant' } as never);
      expect(result.hasSubscription).toBe(expected);
      expect(result.status).toBe(subscription ? 'active' : 'none');
      expect(result.billingEnabled).toBe(true);
      expect(withTenant).toHaveBeenCalledWith('synthetic-tenant', expect.any(Function));
      expect(tx.tenant.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'synthetic-tenant' },
          select: expect.objectContaining({ stripeSubscriptionId: true }),
        }),
      );
    },
  );
});
