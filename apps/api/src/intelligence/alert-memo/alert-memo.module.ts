import { Module } from '@nestjs/common';
import { AiCredentialsModule } from '../../ai-credentials/ai-credentials.module.js';
import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
import { CapiroTruthModule } from '../../capiro-truth/capiro-truth.module.js';
import { ClientDocumentsModule } from '../../client-documents/client-documents.module.js';
import { ContextModule } from '../../context/context.module.js';
import { ReviewsModule } from '../../reviews/reviews.module.js';
import { ReviewsService } from '../../reviews/reviews.service.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertMemoController } from './alert-memo.controller.js';
import { AlertMemoService } from './alert-memo.service.js';
import {
  createGovernedAlertMemoService,
  PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER,
  RAW_ALERT_MEMO_SERVICE,
} from './governed-alert-deliverables.factory.js';
import { HearingRecapController } from './hearing-recap.controller.js';
import { HearingRecapService } from './hearing-recap.service.js';
import { DeliverableEngagementPort } from './deliverable-engagement.port.js';
import { LegiWatchContextPlaneService } from './legiwatch-context-plane.service.js';

/**
 * Phase 22: Alert Memo reasoning consumes shared Context Plane client/history
 * context while bill/hearing/PE/regulation truth remains on the existing Capiro
 * truth + intel evidence rails. The raw legacy compiler dependency is blocked in
 * DI, so the governed wrapper is the only live context acquisition seam.
 */
@Module({
  imports: [
    AiCredentialsModule,
    CapiroTruthModule,
    ClientDocumentsModule,
    ContextModule,
    PrismaModule,
    ReviewsModule,
  ],
  controllers: [AlertMemoController, HearingRecapController],
  providers: [
    DeliverableEngagementPort,
    LegiWatchContextPlaneService,
    {
      provide: RAW_ALERT_MEMO_SERVICE,
      useFactory: (
        credentials: AiCredentialResolverService,
        engagementPort: DeliverableEngagementPort,
        prisma: PrismaService,
        reviews: ReviewsService,
      ) =>
        new AlertMemoService(
          credentials,
          PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER as never,
          engagementPort as never,
          prisma,
          reviews,
        ),
      inject: [
        AiCredentialResolverService,
        DeliverableEngagementPort,
        PrismaService,
        ReviewsService,
      ],
    },
    {
      provide: AlertMemoService,
      useFactory: createGovernedAlertMemoService,
      inject: [RAW_ALERT_MEMO_SERVICE, LegiWatchContextPlaneService],
    },
    HearingRecapService,
  ],
})
export class AlertMemoModule {}
