import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeClient } from '../billing/stripe.client.js';
import { BillingService } from '../billing/billing.service.js';
import { EmailService } from '../email/email.service.js';
import { renderTrialReminderEmail } from '../email/email-templates.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LifecycleRunSummary {
  converted: number;
  remindersSent: number;
  backstopNudges: number;
  backstopCancels: number;
  lockoutsApplied: number;
  lockoutsCleared: number;
  retentionWarnings: number;
  retentionDeletes: number;
}

/**
 * Daily trial/billing lifecycle engine (Gherkin Flow 3 + bridge), run via the
 * `task lifecycle-daily` entrypoint (EventBridge → RunTask). Scoped STRICTLY
 * to self-serve tenants (onboarding_flow_version = 1) — legacy tenants are
 * never touched. Every email is idempotent via onboard_email_log dedupe keys,
 * every state change is audited in onboard_billing_event, and a double-run of
 * the cron is a no-op.
 *
 * Stages:
 *   1. Day-31 trial conversion: trial_ends_at in the past → create the real
 *      subscription from the stored method (card/ACH charge · wire invoice).
 *   2. Reminder cadence: day-1 welcome, ~day-15 check-in, day-25 (5 left),
 *      day-29/30 last-day warning — counted from setup completion.
 *   3. Never-started backstop (decision Q3): setup incomplete 30 days after
 *      provisioning → nudge; 60 days → cancel without charge.
 *   4. Wire/ACH lockout: past_due observed for ONBOARD_UNPAID_LOCKOUT_DAYS →
 *      tenants.locked_at (apps/api's billing state drives the lockout screen);
 *      cleared automatically when payment lands.
 *   5. Retention (decision Q4): canceled 83 days → 7-day warning email;
 *      90 days → hard delete via apps/api's guarded internal endpoint
 *      (deletion_hold pauses it indefinitely).
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeClient,
    private readonly billing: BillingService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  private get lockoutDays(): number {
    // X = wire/ACH lockout window — still TBD with Jordan; env-tunable.
    return Number.parseInt(this.config.get<string>('ONBOARD_UNPAID_LOCKOUT_DAYS') ?? '14', 10);
  }

  async runDaily(now: Date = new Date()): Promise<LifecycleRunSummary> {
    const summary: LifecycleRunSummary = {
      converted: 0,
      remindersSent: 0,
      backstopNudges: 0,
      backstopCancels: 0,
      lockoutsApplied: 0,
      lockoutsCleared: 0,
      retentionWarnings: 0,
      retentionDeletes: 0,
    };
    await this.convertDueTrials(now, summary);
    await this.sendTrialReminders(now, summary);
    await this.runNeverStartedBackstop(now, summary);
    await this.runLockouts(now, summary);
    await this.runRetention(now, summary);
    this.logger.log(`lifecycle-daily: ${JSON.stringify(summary)}`);
    return summary;
  }

  // ── 1. Day-31 conversion ───────────────────────────────────────────────────

  private async convertDueTrials(now: Date, summary: LifecycleRunSummary): Promise<void> {
    if (!this.stripe.enabled) return;
    const due = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          onboardingFlowVersion: 1,
          billingStatus: 'trialing',
          trialEndsAt: { lte: now },
          stripeSubscriptionId: null,
          stripeCustomerId: { not: null },
        },
        select: { id: true, slug: true, stripeCustomerId: true, clientSlots: true },
      }),
    );
    for (const tenant of due) {
      try {
        const session = await this.prisma.onboardSession.findUnique({
          where: { tenantId: tenant.id },
          select: { payMethod: true, purchaser: { select: { email: true, id: true } } },
        });
        const method = session?.payMethod ?? 'card';
        const stripe = this.stripe.require();
        const slotsPrice = this.config.get<string>('STRIPE_PRICE_SLOTS');
        if (!slotsPrice) throw new Error('STRIPE_PRICE_SLOTS is not configured');
        const overagePrice = this.config.get<string>('STRIPE_PRICE_OVERAGE');
        const items = [
          { price: slotsPrice, quantity: Math.max(tenant.clientSlots, 1) },
          ...(overagePrice ? [{ price: overagePrice }] : []),
        ];
        const sub = await stripe.subscriptions.create({
          customer: tenant.stripeCustomerId!,
          items,
          metadata: { tenantId: tenant.id, tenantSlug: tenant.slug, trialConversion: '1' },
          ...(method === 'wire'
            ? {
                collection_method: 'send_invoice' as const,
                days_until_due: Number.parseInt(
                  this.config.get<string>('ONBOARD_WIRE_DUE_DAYS') ?? '14',
                  10,
                ),
              }
            : {
                // Card/ACH: charge the stored default payment method now; a
                // failed charge leaves the subscription past_due → dunning.
                collection_method: 'charge_automatically' as const,
                payment_behavior: 'allow_incomplete' as const,
              }),
        });
        await this.billing.syncSubscription(sub);
        await this.prisma.onboardBillingEvent.create({
          data: {
            tenantId: tenant.id,
            type: 'trial_converted',
            data: { subscriptionId: sub.id, method, slots: tenant.clientSlots },
          },
        });
        if (session?.purchaser?.email) {
          const rendered = renderTrialReminderEmail('trial_ended', tenant.slug, 0);
          await this.email.send({
            to: session.purchaser.email,
            kind: 'trial_ended',
            dedupeKey: `trial_ended:${tenant.id}`,
            tenantId: tenant.id,
            ...rendered,
          });
        }
        summary.converted += 1;
      } catch (err) {
        this.logger.error(`Trial conversion failed for ${tenant.slug}: ${(err as Error).message}`);
      }
    }
  }

  // ── 2. Reminder cadence ────────────────────────────────────────────────────

  private async sendTrialReminders(now: Date, summary: LifecycleRunSummary): Promise<void> {
    const trialing = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          onboardingFlowVersion: 1,
          billingStatus: 'trialing',
          trialEndsAt: { not: null },
        },
        select: { id: true, slug: true, name: true, trialEndsAt: true },
      }),
    );
    for (const tenant of trialing) {
      const daysLeft = Math.ceil((tenant.trialEndsAt!.getTime() - now.getTime()) / DAY_MS);
      const elapsed = 30 - daysLeft;
      // Buckets fire at-or-after their day so a skipped cron run still sends.
      const bucket =
        elapsed >= 29
          ? ('trial_d29' as const)
          : elapsed >= 25
            ? ('trial_d25' as const)
            : elapsed >= 15
              ? ('trial_d15' as const)
              : elapsed >= 1
                ? ('trial_d1' as const)
                : null;
      if (!bucket) continue;
      const recipients = await this.billingAdminEmails(tenant.id);
      for (const to of recipients) {
        const rendered = renderTrialReminderEmail(bucket, tenant.name, Math.max(daysLeft, 0));
        try {
          const result = await this.email.send({
            to,
            kind: bucket,
            dedupeKey: `${bucket}:${tenant.id}:${to}`,
            tenantId: tenant.id,
            ...rendered,
          });
          if (!result.skipped) summary.remindersSent += 1;
        } catch (err) {
          this.logger.warn(`Trial reminder ${bucket} to ${to} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Trial emails go to the billing admins (Gherkin: reminders to Super Admins). */
  private async billingAdminEmails(tenantId: string): Promise<string[]> {
    const rows = await this.prisma.withSystem((tx) =>
      tx.tenantMembership.findMany({
        where: { tenantId, billingAdmin: true, status: 'active' },
        select: { userId: true },
      }),
    );
    if (rows.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { email: true },
    });
    return users.map((u) => u.email).filter((e) => e.includes('@'));
  }

  // ── 3. Never-started backstop (decision Q3) ────────────────────────────────

  private async runNeverStartedBackstop(now: Date, summary: LifecycleRunSummary): Promise<void> {
    const stale = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          onboardingFlowVersion: 1,
          billingStatus: 'trialing',
          trialEndsAt: null, // setup never completed → clock never started
        },
        select: { id: true, slug: true, name: true, createdAt: true },
      }),
    );
    for (const tenant of stale) {
      const ageDays = (now.getTime() - tenant.createdAt.getTime()) / DAY_MS;
      const session = await this.prisma.onboardSession.findUnique({
        where: { tenantId: tenant.id },
        select: { purchaser: { select: { email: true } } },
      });
      const recipients = [
        ...(await this.billingAdminEmails(tenant.id)),
        ...(session?.purchaser?.email ? [session.purchaser.email] : []),
      ];
      if (ageDays >= 60) {
        await this.prisma.withSystem((tx) =>
          tx.tenant.update({
            where: { id: tenant.id },
            data: { billingStatus: 'canceled', canceledAt: now },
          }),
        );
        await this.prisma.onboardBillingEvent.create({
          data: { tenantId: tenant.id, type: 'trial_backstop_cancel', data: { ageDays } },
        });
        for (const to of recipients) {
          const rendered = renderTrialReminderEmail('backstop_cancel', tenant.name, 0);
          await this.email
            .send({
              to,
              kind: 'backstop_cancel',
              dedupeKey: `backstop_cancel:${tenant.id}:${to}`,
              tenantId: tenant.id,
              ...rendered,
            })
            .catch(() => undefined);
        }
        summary.backstopCancels += 1;
      } else if (ageDays >= 30) {
        for (const to of recipients) {
          const rendered = renderTrialReminderEmail('backstop_nudge', tenant.name, 0);
          try {
            const result = await this.email.send({
              to,
              kind: 'backstop_nudge',
              dedupeKey: `backstop_nudge:${tenant.id}:${to}`,
              tenantId: tenant.id,
              ...rendered,
            });
            if (!result.skipped) summary.backstopNudges += 1;
          } catch {
            /* resend next run */
          }
        }
      }
    }
  }

  // ── 4. Wire/ACH lockout ────────────────────────────────────────────────────

  private async runLockouts(now: Date, summary: LifecycleRunSummary): Promise<void> {
    // Apply: past_due observed longer than the window → locked_at.
    const pastDue = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: { onboardingFlowVersion: 1, billingStatus: 'past_due', lockedAt: null },
        select: { id: true, slug: true, name: true },
      }),
    );
    for (const tenant of pastDue) {
      // First observation starts the clock (auditable, cron-idempotent).
      const started = await this.prisma.onboardBillingEvent.findFirst({
        where: { tenantId: tenant.id, type: 'past_due_started' },
        orderBy: { createdAt: 'desc' },
      });
      const resolvedAfter = started
        ? await this.prisma.onboardBillingEvent.findFirst({
            where: {
              tenantId: tenant.id,
              type: 'past_due_resolved',
              createdAt: { gt: started.createdAt },
            },
          })
        : null;
      if (!started || resolvedAfter) {
        await this.prisma.onboardBillingEvent.create({
          data: { tenantId: tenant.id, type: 'past_due_started', data: {} },
        });
        continue;
      }
      const overdueDays = (now.getTime() - started.createdAt.getTime()) / DAY_MS;
      if (overdueDays >= this.lockoutDays) {
        await this.prisma.withSystem((tx) =>
          tx.tenant.update({ where: { id: tenant.id }, data: { lockedAt: now } }),
        );
        await this.prisma.onboardBillingEvent.create({
          data: { tenantId: tenant.id, type: 'lockout_applied', data: { overdueDays } },
        });
        for (const to of await this.billingAdminEmails(tenant.id)) {
          const rendered = renderTrialReminderEmail('lockout', tenant.name, 0);
          await this.email
            .send({
              to,
              kind: 'lockout',
              dedupeKey: `lockout:${tenant.id}:${started.createdAt.toISOString()}:${to}`,
              tenantId: tenant.id,
              ...rendered,
            })
            .catch(() => undefined);
        }
        summary.lockoutsApplied += 1;
        this.logger.warn(`Lockout applied to ${tenant.slug} (${overdueDays.toFixed(1)}d overdue)`);
      }
    }

    // Clear: payment landed (status no longer past_due) → restore access.
    const locked = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          onboardingFlowVersion: 1,
          lockedAt: { not: null },
          billingStatus: { notIn: ['past_due'] },
        },
        select: { id: true, slug: true },
      }),
    );
    for (const tenant of locked) {
      await this.prisma.withSystem((tx) =>
        tx.tenant.update({ where: { id: tenant.id }, data: { lockedAt: null } }),
      );
      await this.prisma.onboardBillingEvent.createMany({
        data: [
          { tenantId: tenant.id, type: 'past_due_resolved', data: {} },
          { tenantId: tenant.id, type: 'lockout_cleared', data: {} },
        ],
      });
      summary.lockoutsCleared += 1;
      this.logger.log(`Lockout cleared for ${tenant.slug}`);
    }
  }

  // ── 5. Retention (decision Q4: warn at 83d, hard delete at 90d) ────────────

  private async runRetention(now: Date, summary: LifecycleRunSummary): Promise<void> {
    const canceled = await this.prisma.withSystem((tx) =>
      tx.tenant.findMany({
        where: {
          onboardingFlowVersion: 1,
          billingStatus: 'canceled',
          canceledAt: { not: null },
          deletionHold: false,
        },
        select: { id: true, slug: true, name: true, canceledAt: true },
      }),
    );
    for (const tenant of canceled) {
      const ageDays = (now.getTime() - tenant.canceledAt!.getTime()) / DAY_MS;
      if (ageDays >= 90) {
        try {
          await this.hardDeleteViaAppsApi(tenant.id);
          summary.retentionDeletes += 1;
          this.logger.warn(`Retention delete executed for ${tenant.slug} (${tenant.id})`);
        } catch (err) {
          this.logger.error(`Retention delete failed for ${tenant.slug}: ${(err as Error).message}`);
        }
      } else if (ageDays >= 83) {
        for (const to of await this.billingAdminEmails(tenant.id)) {
          const rendered = renderTrialReminderEmail('retention_warning', tenant.name, 0);
          try {
            const result = await this.email.send({
              to,
              kind: 'retention_warning',
              dedupeKey: `retention_warning:${tenant.id}:${to}`,
              tenantId: tenant.id,
              ...rendered,
            });
            if (!result.skipped) summary.retentionWarnings += 1;
          } catch {
            /* retry next run */
          }
        }
      }
    }
  }

  private async hardDeleteViaAppsApi(tenantId: string): Promise<void> {
    const base = (this.config.get<string>('ONBOARD_APPS_API_BASE') ?? 'https://app.capiro.ai')
      .replace(/\/$/, '');
    const secret = this.config.get<string>('INTERNAL_SERVICE_SECRET');
    if (!secret) throw new Error('INTERNAL_SERVICE_SECRET is not configured');
    const res = await fetch(`${base}/api/internal/onboarding/tenants/${tenantId}/hard-delete`, {
      method: 'POST',
      headers: { 'x-internal-service-secret': secret },
    });
    if (!res.ok) {
      throw new Error(`hard-delete responded ${res.status}: ${await res.text()}`);
    }
  }
}
