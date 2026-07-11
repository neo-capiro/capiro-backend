// Daily outreach token budget (W3.4 / A7). Unit-tests the budget status math +
// the generate-batch hard-stop, via the prototype-stub pattern.

import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx: TenantContext = {
  tenantId: 't1',
  tenantSlug: 'capiro',
  userId: 'u1',
  clerkUserId: 'c1',
  role: 'standard_user',
} as TenantContext;

/** Build a service whose usage aggregate returns a fixed (input,output) sum. */
function serviceWithUsage(
  budget: number,
  sum: { inputTokens: number; outputTokens: number } | 'throw',
) {
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const patch = service as unknown as Record<string, unknown>;
  patch.outreachDailyTokenBudget = budget;
  patch.logger = { warn: () => {} };
  patch.prisma = {
    withTenant: (_t: string, fn: (tx: unknown) => unknown) =>
      fn({
        aiUsageEvent: {
          aggregate: async () => {
            if (sum === 'throw') throw new Error('db down');
            return { _sum: sum };
          },
        },
      }),
  };
  return service;
}

const status = (svc: EngagementService) =>
  (
    svc as unknown as { outreachBudgetStatus(c: TenantContext): Promise<Record<string, unknown>> }
  ).outreachBudgetStatus(ctx);

describe('outreachBudgetStatus (W3.4)', () => {
  test('budget 0 disables the ceiling', async () => {
    const s = await status(serviceWithUsage(0, { inputTokens: 9_999_999, outputTokens: 0 }));
    expect(s.hardStop).toBe(false);
    expect(s.softWarn).toBe(false);
  });

  test('under 80% → no warn, no stop', async () => {
    const s = await status(serviceWithUsage(1000, { inputTokens: 500, outputTokens: 100 }));
    expect(s.ratio).toBeCloseTo(0.6);
    expect(s.softWarn).toBe(false);
    expect(s.hardStop).toBe(false);
  });

  test('at/over 80% → soft-warn', async () => {
    const s = await status(serviceWithUsage(1000, { inputTokens: 700, outputTokens: 150 }));
    expect(s.softWarn).toBe(true);
    expect(s.hardStop).toBe(false);
  });

  test('at/over 100% → hard-stop', async () => {
    const s = await status(serviceWithUsage(1000, { inputTokens: 900, outputTokens: 200 }));
    expect(s.hardStop).toBe(true);
  });

  test('aggregate read failure fails OPEN (no block)', async () => {
    const s = await status(serviceWithUsage(1000, 'throw'));
    expect(s.hardStop).toBe(false);
    expect(s.softWarn).toBe(false);
  });
});

describe('generateBatchEmails budget hard-stop', () => {
  test('throws a 429-style error before generating when over budget', async () => {
    const service = serviceWithUsage(1000, { inputTokens: 1000, outputTokens: 100 });
    await expect(
      service.generateBatchEmails(ctx, {
        templateId: 'system-outreach-message',
        recipients: [{ email: 'a@mail.house.gov', name: 'A' }],
      }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
