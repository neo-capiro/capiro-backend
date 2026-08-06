import { Injectable, Logger } from '@nestjs/common';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/config.schema.js';
import {
  memoryReviewEmailDeliveryEnabled,
  renderMemoryReviewNotificationEmail,
  type MemoryReviewNotificationEvent,
} from './memory-review-notification.helpers.js';

export interface MemoryReviewEmailSendResult {
  sent: boolean;
  suppressed?: boolean;
  messageId?: string;
  errorCode?: 'email_disabled' | 'email_send_failed';
}

@Injectable()
export class MemoryReviewNotificationEmailService {
  private readonly logger = new Logger(MemoryReviewNotificationEmailService.name);
  private readonly ses: SESv2Client;
  private readonly from: string;
  private readonly appOrigin: string | null;

  constructor(config: ConfigService<AppConfig, true>) {
    this.ses = new SESv2Client({
      region: config.get('AWS_REGION_DEFAULT', { infer: true }),
    });
    this.from = config.get('WORKSPACE_INVITE_EMAIL_FROM', { infer: true });
    this.appOrigin = config.get('WEB_ORIGIN', { infer: true }) ?? null;
  }

  enabled(): boolean {
    return memoryReviewEmailDeliveryEnabled(process.env.MEMORY_REVIEW_EMAIL_DELIVERY);
  }

  async send(input: {
    outboxId: string;
    to: string;
    eventType: MemoryReviewNotificationEvent;
    title: string;
    reviewRequestId: string;
  }): Promise<MemoryReviewEmailSendResult> {
    if (!this.enabled()) {
      return { sent: false, suppressed: true, errorCode: 'email_disabled' };
    }

    const content = renderMemoryReviewNotificationEmail({
      eventType: input.eventType,
      title: input.title,
      reviewRequestId: input.reviewRequestId,
      appOrigin: this.appOrigin,
    });

    try {
      const result = await this.ses.send(
        new SendEmailCommand({
          FromEmailAddress: this.from,
          Destination: { ToAddresses: [input.to] },
          Content: {
            Simple: {
              Subject: { Data: content.subject, Charset: 'UTF-8' },
              Body: {
                Html: { Data: content.html, Charset: 'UTF-8' },
                Text: { Data: content.text, Charset: 'UTF-8' },
              },
            },
          },
          EmailTags: [
            { Name: 'surface', Value: 'memory-review' },
            { Name: 'outbox-id', Value: input.outboxId },
          ],
        }),
      );
      return { sent: true, messageId: result.MessageId };
    } catch (error) {
      this.logger.error(
        `Memory review notification email failed for outbox ${input.outboxId}: ${error instanceof Error ? error.name : 'unknown_error'}`,
      );
      return { sent: false, errorCode: 'email_send_failed' };
    }
  }
}
