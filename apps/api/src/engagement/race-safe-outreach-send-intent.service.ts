import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AttachmentContentService } from './attachment-content.service.js';
import { AttachmentScannerService } from './attachment-scanner.service.js';
import { EngagementService } from './engagement.service.js';
import { EngagementMailSender } from './mail-sender.service.js';
import {
  OutreachSendIntentService,
  type CreateSendIntentInput,
} from './outreach-send-intent.service.js';
import { retryOnceAfterPrismaUnique } from './prisma-unique-retry.js';

/**
 * Production DI wrapper for the send-intent check-then-create race.
 *
 * Two identical first-time requests can both observe no existing requestKey.
 * The database unique constraint chooses one winner; this wrapper retries the
 * loser exactly once so the normal fingerprint comparison sees that winner and
 * returns it as a deduplicated intent. A changed payload still reaches the
 * existing OUTREACH_REQUEST_KEY_REUSED conflict on the retry.
 */
@Injectable()
export class RaceSafeOutreachSendIntentService extends OutreachSendIntentService {
  constructor(
    prisma: PrismaService,
    engagement: EngagementService,
    mailSender: EngagementMailSender,
    attachmentContent: AttachmentContentService,
    attachmentScanner: AttachmentScannerService,
    config: ConfigService<AppConfig, true>,
  ) {
    super(prisma, engagement, mailSender, attachmentContent, attachmentScanner, config);
  }

  override createIntent(
    ctx: TenantContext,
    input: CreateSendIntentInput,
  ): Promise<{ intentId: string; deduped: boolean }> {
    return retryOnceAfterPrismaUnique(() => super.createIntent(ctx, input));
  }
}
