import { Module } from '@nestjs/common';
import { AiCredentialsModule } from '../../ai-credentials/ai-credentials.module.js';
import { AiCredentialResolverService } from '../../ai-credentials/ai-credential-resolver.service.js';
import { CapiroTruthModule } from '../../capiro-truth/capiro-truth.module.js';
import { ClientDocumentsModule } from '../../client-documents/client-documents.module.js';
import { ContextModule } from '../../context/context.module.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { ReviewsModule } from '../../reviews/reviews.module.js';
import { ReviewsService } from '../../reviews/reviews.service.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AlertMemoController } from './alert-memo.controller.js';
import { AlertMemoService } from './alert-memo.service.js';
import {
  createGovernedAlertMemoService,
  RAW_ALERT_MEMO_SERVICE,
} from './governed-alert-deliverables.factory.js';
import { HearingRecapController } from './hearing-recap.controller.js';
import { HearingRecapService } from './hearing-recap.service.js';
import { DeliverableEngagementPort } from './deliverable-engagement.port.js';

/**
 * Alert Memo and Hearing Recap consume neutral credential, truth, document,
 * context, review, and Prisma boundaries. No broad EngagementModule import is
 * required for document mutation or bill truth.
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
    {
      provide: RAW_ALERT_MEMO_SERVICE,
      useFactory: (
        credentials: AiCredentialResolverService,
        contextCompiler: ContextCompilerService,
        engagementPort: DeliverableEngagementPort,
        prisma: PrismaService,
        reviews: ReviewsService,
      ) =>
        new AlertMemoService(
          credentials,
          contextCompiler,
          engagementPort as never,
          prisma,
          reviews,
        ),
      inject: [
        AiCredentialResolverService,
        ContextCompilerService,
        DeliverableEngagementPort,
        PrismaService,
        ReviewsService,
      ],
    },
    {
      provide: AlertMemoService,
      useFactory: createGovernedAlertMemoService,
      inject: [RAW_ALERT_MEMO_SERVICE, ContextCompilerService],
    },
    HearingRecapService,
  ],
})
export class AlertMemoModule {}
