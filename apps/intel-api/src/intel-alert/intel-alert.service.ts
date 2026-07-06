import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  FeatureFlagService,
  TRACKER_OWNER_FEATURE,
} from '../feature-flags/feature-flag.service.js';
import { IntelEmailService } from './intel-email.service.js';
import { toCanonicalAlert } from './canonical-alert.adapter.js';
import {
  clearsMateriality,
  type AlertSeverity,
  type IntelAlertEvent,
} from './intel-alert.types.js';

type Channel = 'email' | 'sms' | 'in_app';

/**
 * Unified alert delivery (Phase 4, plan §7) — SHADOW-FIRST.
 *
 * SINGLE-SENDER GUARANTEE (D5): a real send happens ONLY when a tenant is
 * `tracker_owner_intel`-owned AND the `TRACKER_ALERTS_ENABLED` kill-switch is
 * set. In shadow BOTH are off, so every path computes the would-send payload,
 * logs it (`shadow:true`), writes an idempotent `intel_notification_log` row
 * with status `suppressed_shadow`, and RETURNS before `email.send()`. Even the
 * always-owned internal tenant never sends, because the kill-switch is off.
 *
 * RLS (G3): per-tenant reads/writes go through `withTenant`; the cross-tenant
 * sweeps (emitNewBillAlerts scans all tenants' new bill alerts, flushDigests
 * drains the queue by cadence across tenants) go through `withSystem` and then
 * fan out per-tenant.
 */
@Injectable()
export class IntelAlertService {
  private readonly logger = new Logger(IntelAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly email: IntelEmailService,
  ) {}

  static alertId(clientId: string, billId: string, changeType: string): string {
    return `tracker:${clientId}:${billId}:${changeType}`;
  }

  private killSwitchOff(): boolean {
    return !['true', '1', 'yes'].includes((process.env.TRACKER_ALERTS_ENABLED ?? '').toLowerCase());
  }

  /** Insert a notification-log row; P2002 (already claimed) → null. Idempotent. */
  private async claim(
    tenantId: string,
    clientId: string,
    userId: string,
    alertId: string,
    channel: Channel,
    status: string,
  ): Promise<string | null> {
    try {
      const row = await this.prisma.withTenant(tenantId, (tx) =>
        tx.intelNotificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel, status },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  /**
   * Fan one alert out to every eligible pref for the client. In shadow: log +
   * claim `suppressed_shadow`, send nothing. Returns per-run counters.
   */
  async fanOut(event: IntelAlertEvent): Promise<{ suppressed: number; sent: number }> {
    // Canonical 7-field Alert (SC1.1/SC1.2): map + LOG ONLY — completeness
    // flags surface the field gaps (whoActs/issueId/whyItMatters have no
    // tracker source yet) without ever touching the suppress/send branch.
    const canonical = toCanonicalAlert(event);
    if (!canonical.complete) {
      this.logger.log(
        JSON.stringify({
          canonicalAlertIncomplete: true,
          missingFields: canonical.missingFields,
          clientId: event.clientId,
          billId: event.billId,
          changeType: event.changeType,
        }),
      );
    }
    const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, event.tenantId);
    const canSend = owned && !this.killSwitchOff(); // shadow: false (kill-switch off)
    const alertId = IntelAlertService.alertId(event.clientId, event.billId, event.changeType);
    const prefs = await this.prisma.withTenant(event.tenantId, (tx) =>
      tx.intelAlertPreference.findMany({
        where: { tenantId: event.tenantId, clientId: event.clientId },
      }),
    );

    let suppressed = 0;
    let sent = 0;
    for (const pref of prefs) {
      if (!pref.triggers.includes(event.triggerKey)) continue;
      if (!clearsMateriality(event.severity, pref.materiality)) continue;
      if (!(pref.emailEnabled && pref.emailAddress)) continue;

      const subject = `[Capiro] ${event.displayNum}: ${event.label}`;
      if (!canSend) {
        // SHADOW: compute + log the would-send, claim a suppressed row, send NOTHING.
        this.logger.log(
          JSON.stringify({
            shadow: true,
            tenantId: event.tenantId,
            clientId: event.clientId,
            alertId,
            channel: 'email',
            to: pref.emailAddress,
            subject,
            score: event.score ?? null,
            band: event.band ?? null,
            wouldSendAt: new Date().toISOString(),
          }),
        );
        await this.claim(
          event.tenantId,
          event.clientId,
          pref.userId,
          alertId,
          'email',
          'suppressed_shadow',
        );
        suppressed += 1;
        continue;
      }

      // owned && kill-switch on → real delivery (Phase 8 cutover ONLY).
      const logId = await this.claim(
        event.tenantId,
        event.clientId,
        pref.userId,
        alertId,
        'email',
        'sending',
      );
      if (logId) {
        const res = await this.email.send(pref.emailAddress, subject, `<p>${subject}</p>`, subject);
        await this.prisma.withTenant(event.tenantId, (tx) =>
          tx.intelNotificationLog.update({
            where: { id: logId },
            data: {
              status: res.sent ? 'sent' : 'failed',
              providerMessageId: res.messageId ?? null,
              error: res.error ?? null,
            },
          }),
        );
        if (res.sent) sent += 1;
      }
    }
    return { suppressed, sent };
  }

  /**
   * Read undelivered (`status='new'`) bill alerts and fan each out (shadow). Idempotent:
   * the notification-log @@unique makes re-runs no-ops. Returns counters.
   */
  async emitNewBillAlerts(): Promise<{ alerts: number; suppressed: number; sent: number }> {
    // Cross-tenant emit sweep: reads NEW bill alerts across ALL tenants, then
    // fanOut re-scopes each to its own tenant. Under RLS this MUST bypass.
    const rows = await this.prisma.withSystem((tx) =>
      tx.intelAlert.findMany({
        where: { sourceType: 'bill', status: 'new', deliveredAt: null },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    );
    let suppressed = 0;
    let sent = 0;
    for (const a of rows) {
      const ev = (a.evidence ?? {}) as Record<string, unknown>;
      const event: IntelAlertEvent = {
        tenantId: a.tenantId,
        clientId: a.clientId,
        billId: a.sourceRef,
        displayNum: (ev.displayNum as string) ?? a.sourceRef,
        billTitle: (ev.billTitle as string) ?? a.title,
        changeType: a.changeType ?? a.kind,
        triggerKey: (ev.triggerKey as string) ?? a.kind,
        label: (ev.stage as string) ?? a.title,
        severity: a.severity as AlertSeverity,
        detail: (ev.actionText as string) ?? a.title,
        actionDate: (ev.actionDate as string) ?? null,
        url: (ev.url as string) ?? '',
        why: a.whyItMatters,
        matchedTags: (ev.matchedTags as string[]) ?? [],
        score: a.score,
        band: (ev.band as string) ?? undefined,
      };
      const r = await this.fanOut(event);
      suppressed += r.suppressed;
      sent += r.sent;
    }
    return { alerts: rows.length, suppressed, sent };
  }

  /**
   * Drain the digest queue for a cadence and deliver one summary per
   * (tenant,user,channel). Concurrency-safe via a claim-on-read (mark flushed in
   * the same UPDATE...RETURNING) so overlapping runs don't double-process
   * (plan §7.3a). In shadow nothing is enqueued (fanOut suppresses before
   * enqueue), so this drains 0 rows; the guard is enforced per group anyway.
   */
  async flushDigests(cadence: 'daily' | 'weekly'): Promise<{ flushed: number; sent: number }> {
    // Claim-on-read: atomically mark a batch flushed and return it, so a
    // concurrent run cannot grab the same rows (§7.3a). Cross-tenant drain by
    // cadence → withSystem (bypass RLS); the per-group send below re-checks the
    // per-tenant ownership flag.
    const claimed = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<
        Array<{
          id: string;
          tenant_id: string;
          user_id: string;
          channel: string;
          client_id: string;
        }>
      >(
        `UPDATE intel_alert_digest_queue
          SET flushed = true
        WHERE id IN (
          SELECT id FROM intel_alert_digest_queue
           WHERE cadence = $1 AND flushed = false
           ORDER BY created_at ASC
           LIMIT 5000
           FOR UPDATE SKIP LOCKED
        )
      RETURNING id, tenant_id, user_id, channel, client_id`,
        cadence,
      ),
    );
    if (!claimed.length) return { flushed: 0, sent: 0 };

    let sent = 0;
    const groups = new Map<string, { tenantId: string; userId: string; clientId: string }>();
    for (const r of claimed) {
      groups.set(`${r.tenant_id}|${r.user_id}|${r.channel}`, {
        tenantId: r.tenant_id,
        userId: r.user_id,
        clientId: r.client_id,
      });
    }
    for (const g of groups.values()) {
      const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, g.tenantId);
      if (!(owned && !this.killSwitchOff())) continue; // shadow: suppress (already marked flushed)
      // Phase 8 real digest send would go here.
    }
    return { flushed: claimed.length, sent };
  }

  /**
   * Live shadow self-test (plan §7 S1/S2/S3): exercise the shadow suppress path
   * for a synthetic alert, proving it LOGS a would-send + writes a
   * `suppressed_shadow` row + sends nothing, without needing a real bill move.
   */
  async shadowSelftest(
    tenantId: string,
    clientId: string,
    email = 'selftest@example.com',
  ): Promise<{ suppressed: boolean; sent: number }> {
    const owned = await this.flags.isEnabled(TRACKER_OWNER_FEATURE, tenantId);
    const canSend = owned && !this.killSwitchOff();
    const alertId = IntelAlertService.alertId(clientId, 'selftest-bill', 'bill_amendment');
    const subject = '[Capiro] SELFTEST: shadow suppress';
    this.logger.log(
      JSON.stringify({
        shadow: true,
        selftest: true,
        tenantId,
        clientId,
        alertId,
        channel: 'email',
        to: email,
        subject,
        canSend,
        wouldSendAt: new Date().toISOString(),
      }),
    );
    if (canSend) {
      // Would be a real send at cutover; NOT exercised here (selftest asserts shadow).
      return { suppressed: false, sent: 0 };
    }
    await this.claim(tenantId, clientId, 'selftest-user', alertId, 'email', 'suppressed_shadow');
    return { suppressed: true, sent: 0 };
  }
}
