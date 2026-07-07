import {
  isBillingEntitled,
  LLM_OVERAGE_MULTIPLIER,
  monthlySlotCostUsd,
  pricePerSlotUsd,
} from '@capiro/shared';
import { billingPeriodStart } from './billing.service.js';

describe('client slot pricing (flat $200 — onboarding v1 decision Q2)', () => {
  it('prices every self-serve quantity at $200/slot (volume tiers removed)', () => {
    expect(pricePerSlotUsd(10)).toBe(200);
    expect(pricePerSlotUsd(49)).toBe(200);
    expect(pricePerSlotUsd(50)).toBe(200);
    expect(pricePerSlotUsd(99)).toBe(200);
    expect(pricePerSlotUsd(100)).toBe(200);
    expect(pricePerSlotUsd(5000)).toBe(200);
  });

  it('computes flat monthly totals', () => {
    expect(monthlySlotCostUsd(10)).toBe(2000); // 10 × $200
    expect(monthlySlotCostUsd(50)).toBe(10000); // 50 × $200
    expect(monthlySlotCostUsd(100)).toBe(20000); // 100 × $200
  });
});

describe('billing entitlement', () => {
  it('is entitled only for active / trialing / comped', () => {
    expect(isBillingEntitled('active')).toBe(true);
    expect(isBillingEntitled('trialing')).toBe(true);
    expect(isBillingEntitled('comped')).toBe(true);
    expect(isBillingEntitled('none')).toBe(false);
    expect(isBillingEntitled('past_due')).toBe(false);
    expect(isBillingEntitled('canceled')).toBe(false);
  });
});

describe('overage billing math (2× over the allowance)', () => {
  const billableCents = (usedUsd: number, allowanceUsd: number) =>
    Math.round(Math.max(0, usedUsd - allowanceUsd) * LLM_OVERAGE_MULTIPLIER * 100);

  it('bills nothing at or under the allowance', () => {
    expect(billableCents(150, 200)).toBe(0);
    expect(billableCents(200, 200)).toBe(0);
  });

  it('bills 2× the excess above the allowance', () => {
    expect(billableCents(250, 200)).toBe(10_000); // (250-200) × 2 × 100¢
    expect(billableCents(212.34, 200)).toBe(2_468); // 12.34 × 2 × 100, rounded
  });
});

describe('billingPeriodStart', () => {
  it('falls back to the first of the calendar month (UTC) when no period end', () => {
    expect(billingPeriodStart(null).getUTCDate()).toBe(1);
  });

  it('is one month before the Stripe period end, day-aligned', () => {
    const start = billingPeriodStart(new Date('2026-07-15T08:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-06-15T00:00:00.000Z');
  });
});
