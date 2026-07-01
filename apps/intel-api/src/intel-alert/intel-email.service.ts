import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

export interface EmailSendResult {
  sent: boolean;
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
  private readonly ses: SESv2Client;
  private readonly from: string;

  constructor() {
    this.ses = new SESv2Client({ region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1' });
    this.from = process.env.TRACKER_ALERT_EMAIL_FROM ?? '';
  }

  async send(to: string, subject: string, html: string, text: string): Promise<EmailSendResult> {
    try {
      const res = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [to] },
          Content: {
            Simple: {
              Subject: { Data: subject, Charset: 'UTF-8' },
              Body: { Html: { Data: html, Charset: 'UTF-8' }, Text: { Data: text, Charset: 'UTF-8' } },
            },
          },
        }),
      );
      return { sent: true, messageId: res.MessageId };
    } catch (e) {
      this.logger.error(`Intel alert email to ${to} failed: ${(e as Error).message}`);
      return { sent: false, error: (e as Error).message };
    }
  }
}
