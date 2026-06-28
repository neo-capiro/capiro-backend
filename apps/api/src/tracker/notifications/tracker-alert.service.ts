import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TrackerEmailService } from './tracker-email.service.js';
import { SmsService } from '../sms/sms.service.js';
import { clearsMateriality, type TrackerAlertEvent } from './tracker-notification.types.js';
import { renderAlertEmail, renderDigestEmail, renderTestEmail } from './tracker-email.templates.js';

type Channel = 'email' | 'sms' | 'in_app';

/** Parse "HH:MM" to minutes-since-midnight, or null. */
function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current minutes-since-midnight in America/New_York (the firm's working tz). */
function nowEtMinutes(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return (h % 24) * 60 + m;
}

function isWithinQuietHours(start: string | null, end: string | null): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s == null || e == null) return false;
  const now = nowEtMinutes();
  return s <= e ? now >= s && now < e : now >= s || now < e; // handle midnight wrap
}

/**
 * Fans a tracked-bill change out to each user's enabled channels (email + SMS),
 * gated by triggers, materiality, and quiet hours, with idempotent delivery
 * (one NotificationLog row per alert/user/channel) and digest bucketing. SMS is
 * delivered through SmsService, which is dormant until provisioned.
 */
@Injectable()
export class TrackerAlertService {
  private readonly logger = new Logger(TrackerAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: TrackerEmailService,
    private readonly sms: SmsService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private boardUrl(clientId: string): string {
    const base = this.config.get('TRACKER_APP_BASE_URL', { infer: true }).replace(/\/$/, '');
    return `${base}/clients/${clientId}?tab=tracker`;
  }

  /**
   * Stable per (client, bill, changeType) alert id so re-runs never double-send.
   * Includes clientId because the same user can track the same bill for multiple
   * clients — each is a distinct, client-specific alert (different board link).
   */
  static alertId(clientId: string, billId: string, changeType: string): string {
    return `tracker:${clientId}:${billId}:${changeType}`;
  }

  /**
   * Try to claim (alertId,user,channel) by inserting a NotificationLog row.
   * Returns the row id on success, or null if it already exists (dup → skip).
   */
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
        tx.notificationLog.create({
          data: { tenantId, clientId, userId, alertId, channel, status },
          select: { id: true },
        }),
      );
      return row.id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // already handled
      throw e;
    }
  }

  private async updateLog(
    tenantId: string,
    id: string,
    status: string,
    extra: { providerMessageId?: string; error?: string } = {},
  ): Promise<void> {
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.notificationLog.update({
        where: { id },
        data: {
          status,
          providerMessageId: extra.providerMessageId ?? null,
          error: extra.error ?? null,
        },
      }),
    );
  }

  /**
   * Claim (alertId,user,channel) AND insert the digest-queue row in a SINGLE
   * transaction, so a crash between the two can never leave a 'queued'
   * NotificationLog with no queue row (which would suppress the alert forever).
   * P2002 on the claim means it's already queued → no-op.
   */
  private async claimAndEnqueueDigest(
    event: TrackerAlertEvent,
    alertId: string,
    userId: string,
    channel: 'email' | 'sms',
    cadence: 'daily' | 'weekly',
  ): Promise<void> {
    await this.prisma.withTenant(event.tenantId, async (tx) => {
      try {
        await tx.notificationLog.create({
          data: {
            tenantId: event.tenantId,
            clientId: event.clientId,
            userId,
            alertId,
            channel,
            status: 'queued',
          },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') return; // already queued
        throw e;
      }
      await tx.alertDigestQueue.create({
        data: {
          tenantId: event.tenantId,
          clientId: event.clientId,
          userId,
          channel,
          cadence,
          alertId,
          billId: event.billId,
          payload: event as unknown as object,
        },
      });
    });
  }

  /**
   * Fan one alert out to every user with matching preferences for the client.
   * In-app delivery is implicit (the change is also written to
   * intelligence_change by the detector); this handles email + SMS.
   */
  async fanOut(event: TrackerAlertEvent): Promise<void> {
    if (!this.config.get('TRACKER_ALERTS_ENABLED', { infer: true })) return;

    const prefs = await this.prisma.withTenant(event.tenantId, (tx) =>
      tx.alertPreference.findMany({ where: { clientId: event.clientId } }),
    );
    const alertId = TrackerAlertService.alertId(event.clientId, event.billId, event.changeType);

    for (const pref of prefs) {
      // Trigger gate (in-app is always on; channel delivery respects triggers).
      if (!pref.triggers.includes(event.triggerKey)) continue;
      // Materiality gate.
      if (!clearsMateriality(event.severity, pref.materiality)) continue;

      // ── Email ──────────────────────────────────────────────────────────
      if (pref.emailEnabled && pref.emailAddress) {
        if (pref.emailCadence === 'realtime') {
          const logId = await this.claim(
            event.tenantId,
            event.clientId,
            pref.userId,
            alertId,
            'email',
            'sending',
          );
          if (logId) {
            const { subject, html, text } = renderAlertEmail({
              ...event,
              url: this.boardUrl(event.clientId),
            });
            const res = await this.email.send(pref.emailAddress, subject, html, text);
            await this.updateLog(event.tenantId, logId, res.sent ? 'sent' : 'failed', {
              providerMessageId: res.messageId,
              error: res.error,
            });
          }
        } else {
          await this.claimAndEnqueueDigest(
            event,
            alertId,
            pref.userId,
            'email',
            pref.emailCadence as 'daily' | 'weekly',
          );
        }
      }

      // ── SMS (dormant until provisioned) ────────────────────────────────
      if (pref.smsEnabled && pref.smsPhoneVerified && pref.smsPhone) {
        const inQuiet = isWithinQuietHours(pref.quietHoursStart, pref.quietHoursEnd);
        if (pref.smsCadence === 'realtime' && !inQuiet) {
          const logId = await this.claim(
            event.tenantId,
            event.clientId,
            pref.userId,
            alertId,
            'sms',
            'sending',
          );
          if (logId) {
            const body =
              `${event.displayNum}: ${event.label} — ${event.billTitle}. ${this.boardUrl(event.clientId)}`.slice(
                0,
                320,
              );
            const res = await this.sms.send(pref.smsPhone, body);
            const status = res.sent ? 'sent' : res.dormant ? 'suppressed' : 'failed';
            await this.updateLog(event.tenantId, logId, status, {
              providerMessageId: res.providerMessageId,
              error: res.error,
            });
          }
        } else {
          // Quiet hours or digest cadence → defer to the daily SMS digest.
          await this.claimAndEnqueueDigest(event, alertId, pref.userId, 'sms', 'daily');
        }
      }
    }
  }

  /**
   * Drain queued digest alerts for a cadence and deliver one summary per
   * (user, channel). Marks rows flushed; idempotent on the per-event
   * NotificationLog already written at enqueue time.
   */
  async flushDigests(cadence: 'daily' | 'weekly'): Promise<{ flushed: number; sent: number }> {
    if (!this.config.get('TRACKER_ALERTS_ENABLED', { infer: true })) return { flushed: 0, sent: 0 };

    // Cross-tenant drain (scheduled worker path).
    const rows = await this.prisma.withSystem((tx) =>
      tx.alertDigestQueue.findMany({
        where: { cadence, flushed: false },
        orderBy: { createdAt: 'asc' },
        take: 5000,
      }),
    );
    if (!rows.length) return { flushed: 0, sent: 0 };

    // Group by tenant|user|channel, carrying the resolved fields (not just a key).
    interface Group {
      tenantId: string;
      userId: string;
      channel: string;
      clientId: string;
      rows: typeof rows;
    }
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const key = `${r.tenantId}|${r.userId}|${r.channel}`;
      const g =
        groups.get(key) ??
        ({
          tenantId: r.tenantId,
          userId: r.userId,
          channel: r.channel,
          clientId: r.clientId,
          rows: [],
        } as Group);
      g.rows.push(r);
      groups.set(key, g);
    }

    let sent = 0;
    for (const { tenantId, userId, channel, clientId, rows: batch } of groups.values()) {
      const events = batch.map((b) => b.payload as unknown as TrackerAlertEvent);
      try {
        if (channel === 'email') {
          const pref = await this.prisma.withTenant(tenantId, (tx) =>
            tx.alertPreference.findFirst({ where: { userId, clientId } }),
          );
          if (pref?.emailEnabled && pref.emailAddress) {
            const { subject, html, text } = renderDigestEmail(
              events,
              cadence,
              this.boardUrl(clientId),
            );
            const res = await this.email.send(pref.emailAddress, subject, html, text);
            if (res.sent) sent += 1;
          }
        } else if (channel === 'sms') {
          const pref = await this.prisma.withTenant(tenantId, (tx) =>
            tx.alertPreference.findFirst({ where: { userId, clientId } }),
          );
          if (pref?.smsEnabled && pref.smsPhoneVerified && pref.smsPhone) {
            const body =
              `Capiro: ${events.length} tracked-bill update(s). ${this.boardUrl(clientId)}`.slice(
                0,
                320,
              );
            const res = await this.sms.send(pref.smsPhone, body);
            if (res.sent) sent += 1;
          }
        }
      } catch (e) {
        this.logger.error(`Digest flush failed for ${userId}/${channel}: ${(e as Error).message}`);
      }
      // Mark this batch flushed regardless (a failed send is logged; we don't
      // want a poison row to re-send forever).
      await this.prisma.withSystem((tx) =>
        tx.alertDigestQueue.updateMany({
          where: { id: { in: batch.map((b) => b.id) } },
          data: { flushed: true },
        }),
      );
    }
    return { flushed: rows.length, sent };
  }

  /**
   * Fire a sample alert to the requested channels for one user, bypassing the
   * trigger/materiality gates (it's a manual wiring test). Returns the per-
   * channel outcome so the UI can confirm delivery.
   */
  async sendTestAlert(
    tenantId: string,
    clientId: string,
    userId: string,
    channels: Channel[],
  ): Promise<{ channel: Channel; status: string }[]> {
    const pref = await this.prisma.withTenant(tenantId, (tx) =>
      tx.alertPreference.findFirst({ where: { userId, clientId } }),
    );
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { name: true } }),
    );
    const out: { channel: Channel; status: string }[] = [];

    for (const channel of channels) {
      if (channel === 'in_app') {
        out.push({ channel, status: 'sent' });
        continue;
      }
      if (channel === 'email') {
        const to = pref?.emailAddress;
        if (!pref?.emailEnabled || !to) {
          out.push({ channel, status: 'skipped' });
          continue;
        }
        const { subject, html, text } = renderTestEmail(
          client?.name ?? null,
          this.boardUrl(clientId),
        );
        const res = await this.email.send(to, subject, html, text);
        out.push({ channel, status: res.sent ? 'sent' : 'failed' });
        continue;
      }
      if (channel === 'sms') {
        if (!pref?.smsEnabled || !pref.smsPhoneVerified || !pref.smsPhone) {
          out.push({ channel, status: 'skipped' });
          continue;
        }
        const res = await this.sms.send(
          pref.smsPhone,
          `Capiro test alert — your bill-tracker SMS is wired up. ${this.boardUrl(clientId)}`,
        );
        out.push({ channel, status: res.sent ? 'sent' : res.dormant ? 'suppressed' : 'failed' });
      }
    }
    return out;
  }
}
