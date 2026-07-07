import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type BillingStatus,
  type BillingSummary,
  type TenantContext,
  MIN_CLIENT_SLOTS,
  LLM_OVERAGE_MULTIPLIER,
  LLM_WARN_THRESHOLD,
  monthlySlotCostUsd,
  pricePerSlotUsd,
} from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiUsageService } from '../ai-usage/ai-usage.service.js';

/**
 * READ-ONLY billing views (onboarding v1). Every Stripe call and every write
 * to the tenant billing columns moved to apps/onboard-api — the single Stripe
 * writer (docs/plans/onboarding-v1-plan.md §3). This service keeps:
 *   • getState   — minimal posture for ALL roles (BillingGate / trial banner);
 *     deliberately free of costs, prices, and payment info (Gherkin: billing
 *     is entirely hidden from non-billing-admins).
 *   • getSummary — the full summary; controller gates it to billing admins.
 *   • adminListCustomers — cross-tenant staff console rows (capiro_admin).
 * Enforcement is switched by BILLING_ENFORCED (the old implicit
 * Boolean(STRIPE_SECRET_KEY) signal no longer exists in this service).
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  get billingEnforced(): boolean {
    return this.config.get('BILLING_ENFORCED', { infer: true });
  }

  // ---------------------------------------------------------------------------
  // Minimal state — safe for every role (no costs, no payment info)
  // ---------------------------------------------------------------------------

  async getState(ctx: TenantContext): Promise<BillingState> {
    const [tenant, usedSlots] = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: {
          billingStatus: true,
          clientSlots: true,
          trialEndsAt: true,
          onboardingFlowVersion: true,
          currentPeriodEnd: true,
          lockedAt: true,
        },
      });
      const usedSlots = await tx.client.count({
        where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
      return [tenant, usedSlots] as const;
    });

    return {
      billingEnabled: this.billingEnforced,
      status: (tenant?.billingStatus ?? 'none') as BillingStatus,
      slots: tenant?.clientSlots ?? 0,
      usedSlots,
      trialEndsAt: tenant?.trialEndsAt ? tenant.trialEndsAt.toISOString() : null,
      onboardingFlowVersion: tenant?.onboardingFlowVersion ?? null,
      // Wire/ACH lockout (Gherkin bridge): all access suspended while set.
      locked: this.billingEnforced && Boolean(tenant?.lockedAt),
    };
  }

  // ---------------------------------------------------------------------------
  // Full summary (billing admins + capiro_admin only — controller-gated)
  // ---------------------------------------------------------------------------

  async getSummary(ctx: TenantContext): Promise<BillingSummary> {
    const [tenant, usedSlots] = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: {
          billingStatus: true,
          clientSlots: true,
          llmAllowanceUsdPerSlot: true,
          llmHardCapUsd: true,
          currentPeriodEnd: true,
          stripeCustomerId: true,
          stripeSubscriptionId: true,
        },
      });
      const usedSlots = await tx.client.count({
        where: { tenantId: ctx.tenantId, status: { not: 'archived' } },
      });
      return [tenant, usedSlots] as const;
    });

    const slots = tenant?.clientSlots ?? 0;
    const allowancePerSlot = Number(tenant?.llmAllowanceUsdPerSlot ?? 20);
    const llmAllowanceUsd = slots * allowancePerSlot;

    const periodStart = billingPeriodStart(tenant?.currentPeriodEnd ?? null);
    const usage = await this.aiUsage.tenantSummaryByTenantId(ctx.tenantId, { from: periodStart });
    const llmUsedUsd = usage.totalCostUsd;
    const llmOverageUsd =
      llmAllowanceUsd > 0 ? Math.max(0, llmUsedUsd - llmAllowanceUsd) * LLM_OVERAGE_MULTIPLIER : 0;
    const llmWarn = llmAllowanceUsd > 0 && llmUsedUsd >= llmAllowanceUsd * LLM_WARN_THRESHOLD;

    return {
      billingEnabled: this.billingEnforced,
      status: (tenant?.billingStatus ?? 'none') as BillingStatus,
      slots,
      usedSlots,
      pricePerSlotUsd: pricePerSlotUsd(slots || MIN_CLIENT_SLOTS),
      llmAllowanceUsd,
      llmUsedUsd,
      llmOverageUsd,
      llmWarn,
      llmHardCapUsd: tenant?.llmHardCapUsd != null ? Number(tenant.llmHardCapUsd) : null,
      currentPeriodEnd: tenant?.currentPeriodEnd ? tenant.currentPeriodEnd.toISOString() : null,
      hasSubscription: Boolean(tenant?.stripeCustomerId),
    };
  }

  // ---------------------------------------------------------------------------
  // Capiro-admin: cross-tenant customer list (read-only; comp toggle moved to
  // onboard-api POST /onboard-api/admin/billing/tenants/:id/comp)
  // ---------------------------------------------------------------------------

  /**
   * Every tenant with its billing posture + month-to-date LLM spend, for the
   * capiro-admin "Customers" console. Cross-tenant (withSystem) — only reachable
   * behind the capiro_admin guard at the controller layer. MRR is the recurring
   * slot revenue for paying statuses (comped/none/canceled contribute $0).
   */
  async adminListCustomers(): Promise<AdminCustomerRow[]> {
    const { tenants, slotCounts } = await this.prisma.withSystem(async (tx) => {
      const tenants = await tx.tenant.findMany({
        select: {
          id: true,
          slug: true,
          name: true,
          billingStatus: true,
          clientSlots: true,
          llmAllowanceUsdPerSlot: true,
          currentPeriodEnd: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      const slotCounts = await tx.client.groupBy({
        by: ['tenantId'],
        where: { status: { not: 'archived' } },
        _count: { _all: true },
      });
      return { tenants, slotCounts };
    });

    const usage = await this.aiUsage.adminAllTenantsSummary();
    const usedByTenant = new Map(usage.map((u) => [u.tenantId, u.totalCostUsd]));
    const slotsUsedByTenant = new Map(slotCounts.map((s) => [s.tenantId, s._count._all]));

    return tenants.map((t) => {
      const status = t.billingStatus as BillingStatus;
      const paying = status === 'active' || status === 'trialing' || status === 'past_due';
      const allowanceUsd = t.clientSlots * Number(t.llmAllowanceUsdPerSlot);
      const llmUsedUsd = usedByTenant.get(t.id) ?? 0;
      const llmOverageUsd =
        allowanceUsd > 0 ? Math.max(0, llmUsedUsd - allowanceUsd) * LLM_OVERAGE_MULTIPLIER : 0;
      return {
        tenantId: t.id,
        slug: t.slug,
        name: t.name,
        status,
        slots: t.clientSlots,
        usedSlots: slotsUsedByTenant.get(t.id) ?? 0,
        pricePerSlotUsd: pricePerSlotUsd(t.clientSlots || MIN_CLIENT_SLOTS),
        mrrUsd: paying ? monthlySlotCostUsd(t.clientSlots) : 0,
        llmUsedUsd,
        llmOverageUsd,
        currentPeriodEnd: t.currentPeriodEnd ? t.currentPeriodEnd.toISOString() : null,
        createdAt: t.createdAt.toISOString(),
      };
    });
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

/** Minimal posture for all roles — no costs, prices, or payment info. */
export interface BillingState {
  billingEnabled: boolean;
  status: BillingStatus;
  slots: number;
  usedSlots: number;
  trialEndsAt: string | null;
  onboardingFlowVersion: number | null;
  /** Wire/ACH lockout — access suspended until payment confirms. */
  locked: boolean;
}

export interface AdminCustomerRow {
  tenantId: string;
  slug: string;
  name: string;
  status: BillingStatus;
  slots: number;
  usedSlots: number;
  pricePerSlotUsd: number;
  mrrUsd: number;
  llmUsedUsd: number;
  llmOverageUsd: number;
  currentPeriodEnd: string | null;
  createdAt: string;
}
