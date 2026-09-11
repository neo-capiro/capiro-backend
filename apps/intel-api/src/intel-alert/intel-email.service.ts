import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface EmailSendResult {
  sent: boolean;
  outcome?: ReportEmailResult['outcome'];
  messageId?: string;
  error?: string;
}
export interface ReportEmailResult {
  outcome: 'accepted' | 'retryable' | 'terminal' | 'uncertain';
  messageId?: string;
  error?: string;
}

/**
 * Alert email delivery via Amazon SESv2 (Phase 4, ported from
 * apps/api/.../tracker-email.service.ts). Reads region + from-address from env
 * (AWS_REGION_DEFAULT, TRACKER_ALERT_EMAIL_FROM). This is NEVER called in
 * shadow — IntelAlertService.fanOut suppresses before reaching send() (the real
 * send path is gated by owned && TRACKER_ALERTS_ENABLED, both off in shadow).
 */
@Injectable()
export class IntelEmailService {
  private readonly logger = new Logger(IntelEmailService.name);
  private readonly from: string;
  private readonly reportSes: SESv2Client;

  constructor() {
    this.from = process.env.TRACKER_ALERT_EMAIL_FROM ?? '';
    // A request that might have been accepted must never be blindly resent by
    // an SDK retry. Phase 2 persists uncertainty for explicit reconciliation.
    this.reportSes = new SESv2Client({ region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1', maxAttempts: 1 });
  }

  async sendReport(to: string, role: 'to' | 'bcc', subject: string, html: string, text: string): Promise<ReportEmailResult> {
    if (!this.from) return { outcome: 'terminal', error: 'SENDER_NOT_CONFIGURED' };
    try {
      const result = await this.reportSes.send(new SendEmailCommand({ FromEmailAddress: this.from,
        Destination: role === 'bcc' ? { BccAddresses: [to] } : { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: {
          Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' },
        } } },
      }));
      return result.MessageId ? { outcome: 'accepted', messageId: result.MessageId } : { outcome: 'uncertain', error: 'PROVIDER_ACK_MISSING' };
    } catch (error) {
      const name = (error as { name?: string }).name ?? 'Unknown';
      const retryable = ['TooManyRequestsException', 'ThrottlingException'].includes(name);
      const terminal = ['MessageRejected', 'BadRequestException', 'MailFromDomainNotVerifiedException', 'AccountSuspendedException', 'SendingPausedException'].includes(name);
      return { outcome: retryable ? 'retryable' : terminal ? 'terminal' : 'uncertain', error: name };
    }
  }

  async send(to: string, subject: string, html: string, text: string): Promise<EmailSendResult> {
    const result = await this.sendReport(to, 'to', subject, html, text);
    return { ...result, sent: result.outcome === 'accepted' };
  }
}
