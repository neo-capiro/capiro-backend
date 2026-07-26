import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SourceDataRepository } from '../sourcedata/source-data.repository.js';
import { IntelEmailService } from '../intel-alert/intel-email.service.js';
import { SmsService } from './sms/sms.service.js';
import { renderTestEmail } from './tracker-email.templates.js';

export type TestAlertChannel = 'email' | 'sms' | 'in_app';

/**
 * Configure-panel test alert (P1.1, ported from apps/api
 * tracker-alert.service.sendTestAlert). Prefs come from
 * `intel_alert_preference`; the client name is a tenant-scoped `clients` read
 * via SourceDataRepository. Email goes through the already-ported SESv2
 * IntelEmailService; SMS through the ported (dormant) SmsService.
 *
 * DELIBERATELY exempt from the TRACKER_ALERTS_ENABLED kill-switch and the
 * fanOut single-sender guard: a test alert is a user-initiated wiring check
 * (same contract as legacy), fires only for the requesting user, bypasses the
 * trigger/materiality gates, and writes NO notification-log row.
 */
@Injectable()
export class TrackerTestAlertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: SourceDataRepository,
    private readonly email: IntelEmailService,
    private readonly sms: SmsService,
  ) {}

  /** Deep link to the client's Tracker tab (TRACKER_APP_BASE_URL env). */
  private boardUrl(clientId: string): string {
    const base = (process.env.TRACKER_APP_BASE_URL ?? 'https://app.capiro.ai').replace(/\/$/, '');
    return `${base}/clients/${clientId}?tab=tracker`;
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
    channels: TestAlertChannel[],
  ): Promise<{ channel: TestAlertChannel; status: string; detail?: string }[]> {
    const prefRow = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
      }),
    );
    const pref = prefRow && prefRow.tenantId === tenantId ? prefRow : null;
    const client = await this.repo.getClientProfile(tenantId, clientId);
    const out: { channel: TestAlertChannel; status: string; detail?: string }[] = [];

    for (const channel of channels) {
      if (channel === 'in_app') {
        out.push({ channel, status: 'sent' });
        continue;
      }
      if (channel === 'email') {
        const to = pref?.emailAddress;
        if (!pref?.emailEnabled || !to) {
          out.push({
            channel,
            status: 'skipped',
            detail: !pref?.emailEnabled ? 'email channel is off' : 'no email address saved',
          });
          continue;
        }
        const { subject, html, text } = renderTestEmail(
          client?.name ?? null,
          this.boardUrl(clientId),
        );
        const res = await this.email.send(to, subject, html, text);
        // P1-05: surface WHY a send failed — truncated, and never the recipient address.
        out.push({
          channel,
          status: res.sent ? 'sent' : 'failed',
          ...(res.sent ? {} : { detail: (res.error ?? 'send failed').slice(0, 200) }),
        });
        continue;
      }
      if (channel === 'sms') {
        if (!pref?.smsEnabled || !pref.smsPhoneVerified || !pref.smsPhone) {
          out.push({
            channel,
            status: 'skipped',
            detail: !pref?.smsEnabled
              ? 'SMS channel is off'
              : !pref.smsPhoneVerified
                ? 'phone not verified'
                : 'no phone number saved',
          });
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
