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
import { RepresentationModule } from '../../clients/representation.module.js';
import { RepresentationResolverService } from '../../clients/representation-resolver.service.js';
import { DistrictBriefController } from './district-brief.controller.js';
import { DistrictBriefService } from './district-brief.service.js';
import {
  createGovernedDistrictBriefService,
  PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER,
  RAW_DISTRICT_BRIEF_SERVICE,
} from './governed-alert-deliverables.factory.js';
import { DeliverableEngagementPort } from './deliverable-engagement.port.js';
import { LegiWatchContextPlaneService } from './legiwatch-context-plane.service.js';

/**
 * Phase 22 district-brief adoption. Facility, representation, committee and
 * legislative facts remain deterministic/local fact-sheet inputs; shared client
 * context comes only through LegiWatchContextPlaneService.
 */
@Module({
  imports: [
    PrismaModule,
    RepresentationModule,
    AiCredentialsModule,
    CapiroTruthModule,
    ClientDocumentsModule,
    ContextModule,
    ReviewsModule,
  ],
  controllers: [DistrictBriefController],
  providers: [
    DeliverableEngagementPort,
    LegiWatchContextPlaneService,
    {
      provide: RAW_DISTRICT_BRIEF_SERVICE,
      useFactory: (
        prisma: PrismaService,
        representation: RepresentationResolverService,
        credentials: AiCredentialResolverService,
        engagementPort: DeliverableEngagementPort,
        reviews: ReviewsService,
      ) =>
        new DistrictBriefService(
          prisma,
          representation,
          credentials,
          PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER as never,
          engagementPort as never,
          reviews,
        ),
      inject: [
        PrismaService,
        RepresentationResolverService,
        AiCredentialResolverService,
        DeliverableEngagementPort,
        ReviewsService,
      ],
    },
    {
      provide: DistrictBriefService,
      useFactory: createGovernedDistrictBriefService,
      inject: [RAW_DISTRICT_BRIEF_SERVICE, LegiWatchContextPlaneService],
    },
  ],
})
export class DistrictBriefModule {}
