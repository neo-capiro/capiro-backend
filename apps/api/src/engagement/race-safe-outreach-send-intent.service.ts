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
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';

/**
 * Production DI wrapper for the send-intent check-then-create race.
 * Request/core construction owns no timer; EngagementWorkersModule does.
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
    runtimePolicy: EngagementRuntimePolicyService,
  ) {
    super(
      prisma,
      engagement,
      mailSender,
      attachmentContent,
      attachmentScanner,
      config,
      runtimePolicy,
    );
  }

  /** Request/core construction must never start a worker timer. */
  override onModuleInit(): void {}

  override onModuleDestroy(): void {}

  runWorkerSweep(): Promise<void> {
    return super.runSweep();
  }

  override createIntent(
    ctx: TenantContext,
    input: CreateSendIntentInput,
  ): Promise<{ intentId: string; deduped: boolean }> {
    return retryOnceAfterPrismaUnique(() => super.createIntent(ctx, input));
  }
}
