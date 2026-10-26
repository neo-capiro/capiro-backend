import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { SESv2Client, SESv2ServiceException, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';

export interface EmailSendResult {
  status: 'accepted' | 'failed' | 'outcome_unknown';
  messageId?: string;
  error?: string;
}

/** A parsed SES rejection proves failure; a timeout, lost response or 5xx does not. */
export function sesEmailFailure(cause: unknown): EmailSendResult {
  const status =
    cause instanceof SESv2ServiceException ? cause.$metadata.httpStatusCode : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408
    ? { status: 'failed', error: 'SES rejected the request' }
    : { status: 'outcome_unknown', error: 'SES acceptance could not be confirmed' };
}

export function sesEmailAcceptance(messageId: string | undefined): EmailSendResult {
  return messageId?.trim()
    ? { status: 'accepted', messageId }
    : { status: 'outcome_unknown', error: 'SES acceptance receipt missing' };
}

/** Tracker alert email delivery via Amazon SESv2 (same path as demo requests). */
@Injectable()
export class TrackerEmailService implements OnModuleDestroy {
  private readonly logger = new Logger(TrackerEmailService.name);
  private readonly ses: SESv2Client;
  private readonly from: string;

  constructor(config: ConfigService<AppConfig, true>) {
    const region = config.get('AWS_REGION_DEFAULT', { infer: true });
    this.ses = new SESv2Client({ region, maxAttempts: 1 });
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
      return sesEmailAcceptance(res.MessageId);
    } catch (e) {
      const result = sesEmailFailure(e);
      this.logger.warn(`Tracker SES outcome: ${result.status}`);
      return result;
    }
  }

  onModuleDestroy(): void {
    this.ses.destroy();
  }
}
