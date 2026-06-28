import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';

export interface EmailSendResult {
  sent: boolean;
  messageId?: string;
  error?: string;
}

/** Tracker alert email delivery via Amazon SESv2 (same path as demo requests). */
@Injectable()
export class TrackerEmailService {
  private readonly logger = new Logger(TrackerEmailService.name);
  private readonly ses: SESv2Client;
  private readonly from: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.ses = new SESv2Client({ region });
    this.from = config.get('TRACKER_ALERT_EMAIL_FROM', { infer: true });
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
              Body: {
                Html: { Data: html, Charset: 'UTF-8' },
                Text: { Data: text, Charset: 'UTF-8' },
              },
            },
          },
        }),
      );
      return { sent: true, messageId: res.MessageId };
    } catch (e) {
      this.logger.error(`Tracker alert email to ${to} failed: ${(e as Error).message}`);
      return { sent: false, error: (e as Error).message };
    }
  }
}
