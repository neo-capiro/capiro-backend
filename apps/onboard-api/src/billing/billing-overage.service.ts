import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LLM_OVERAGE_MULTIPLIER } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiUsageReaderService } from './ai-usage-reader.service.js';
import { StripeClient } from './stripe.client.js';
import { billingPeriodStart } from './billing.service.js';

export interface OverageReportResult {
  tenantId: string;
  tenantSlug: string;
  usedUsd: number;
  allowanceUsd: number;
  billableOverageCents: number;
  reportedDeltaCents: number;
}

/**
 * Computes per-tenant LLM overage and reports the incremental amount to the
 * Stripe metered "overage" price (ported from apps/api; runs daily via the
 * `task report-llm-overage` entrypoint verb).
 *
 * Billing model: each tenant gets a pooled allowance of
 *   llmAllowanceUsdPerSlot × clientSlots
 * of REAL LLM cost (ai_usage_events.cost_usd) per billing period. Beyond
 * that, overage is billed at LLM_OVERAGE_MULTIPLIER × the real cost.
 *
 * Idempotent / no double-billing: tenant_usage_meters tracks cumulative cents
 * already reported for the period; we only ever report the positive delta. A
 * fresh period (new period_start key) resets the cumulative to 0, matching
 * Stripe's per-period meter reset.
 */
@Injectable()
export class BillingOverageService {
  private readonly logger = new Logger(BillingOverageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly aiUsage: AiUsageReaderService,
    private readonly config: ConfigService,
  ) {}

  private get meterEventName(): string {
    return this.config.get<string>('STRIPE_OVERAGE_METER_EVENT') ?? 'llm_overage_cents';
  }

  private get overageConfigured(): boolean {
    return this.stripe.enabled && Boolean(this.config.get<string>('STRIPE_PRICE_OVERAGE'));
  }

  /** Run the overage computation + report for every paying tenant. */
  async reportOverageForAllTenants(): Promise<OverageReportResult[]> {
    // Paying tenants only: comped / none / canceled never accrue overage.
    const tenants = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          billingStatus: { in: ['active', 'trialing', 'past_due'] },
          stripeCustomerId: { not: null },
          clientSlots: { gt: 0 },
        },
        select: {
          id: true,
          slug: true,
          stripeCustomerId: true,
          clientSlots: true,
          llmAllowanceUsdPerSlot: true,
          currentPeriodEnd: true,
        },
      }),
    );

    const results: OverageReportResult[] = [];
    for (const t of tenants) {
      try {
        results.push(
          await this.reportForTenant({
            id: t.id,
            slug: t.slug,
            stripeCustomerId: t.stripeCustomerId!,
            clientSlots: t.clientSlots,
            allowancePerSlot: Number(t.llmAllowanceUsdPerSlot),
            currentPeriodEnd: t.currentPeriodEnd,
          }),
        );
      } catch (err) {
        this.logger.error(`Overage report failed for ${t.slug}: ${(err as Error).message}`);
      }
    }
    return results;
  }

  private async reportForTenant(t: {
    id: string;
    slug: string;
    stripeCustomerId: string;
    clientSlots: number;
    allowancePerSlot: number;
    currentPeriodEnd: Date | null;
  }): Promise<OverageReportResult> {
    const periodStart = billingPeriodStart(t.currentPeriodEnd);
    const usedUsd = await this.aiUsage.tenantCostUsdSince(t.id, periodStart);
    const allowanceUsd = t.clientSlots * t.allowancePerSlot;
    const overageUsd = Math.max(0, usedUsd - allowanceUsd);
    const billableOverageCents = Math.round(overageUsd * LLM_OVERAGE_MULTIPLIER * 100);

    // Compute the delta vs what we've already reported this period and persist
    // the new cumulative in the same transaction.
    const deltaCents = await this.prisma.withSystem(async (tx) => {
      const existing = await tx.tenantUsageMeter.findUnique({
        where: { tenantId_periodStart: { tenantId: t.id, periodStart } },
      });
      const reported = existing?.reportedOverageCents ?? 0;
      const delta = billableOverageCents - reported;
      if (delta <= 0) {
        if (!existing) {
          await tx.tenantUsageMeter.create({
            data: { tenantId: t.id, periodStart, reportedOverageCents: billableOverageCents },
          });
        }
        return 0;
      }
      await tx.tenantUsageMeter.upsert({
        where: { tenantId_periodStart: { tenantId: t.id, periodStart } },
        create: { tenantId: t.id, periodStart, reportedOverageCents: billableOverageCents },
        update: { reportedOverageCents: billableOverageCents },
      });
      return delta;
    });

    if (deltaCents > 0 && this.overageConfigured) {
      await this.stripe.require().billing.meterEvents.create({
        event_name: this.meterEventName,
        payload: { stripe_customer_id: t.stripeCustomerId, value: String(deltaCents) },
      });
      this.logger.log(
        `${t.slug}: reported +${deltaCents}¢ overage (used $${usedUsd.toFixed(2)} / allow $${allowanceUsd.toFixed(2)})`,
      );
    }

    return {
      tenantId: t.id,
      tenantSlug: t.slug,
      usedUsd,
      allowanceUsd,
      billableOverageCents,
      reportedDeltaCents: deltaCents,
    };
  }
}
