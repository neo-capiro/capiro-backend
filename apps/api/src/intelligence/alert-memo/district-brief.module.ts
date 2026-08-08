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
import { RepresentationModule } from '../../clients/representation.module.js';
import { RepresentationResolverService } from '../../clients/representation-resolver.service.js';
import { DistrictBriefController } from './district-brief.controller.js';
import { DistrictBriefService } from './district-brief.service.js';
import {
  createGovernedDistrictBriefService,
  RAW_DISTRICT_BRIEF_SERVICE,
} from './governed-alert-deliverables.factory.js';
import { DeliverableEngagementPort } from './deliverable-engagement.port.js';

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
    {
      provide: RAW_DISTRICT_BRIEF_SERVICE,
      useFactory: (
        prisma: PrismaService,
        representation: RepresentationResolverService,
        credentials: AiCredentialResolverService,
        contextCompiler: ContextCompilerService,
        engagementPort: DeliverableEngagementPort,
        reviews: ReviewsService,
      ) =>
        new DistrictBriefService(
          prisma,
          representation,
          credentials,
          contextCompiler,
          engagementPort as never,
          reviews,
        ),
      inject: [
        PrismaService,
        RepresentationResolverService,
        AiCredentialResolverService,
        ContextCompilerService,
        DeliverableEngagementPort,
        ReviewsService,
      ],
    },
    {
      provide: DistrictBriefService,
      useFactory: createGovernedDistrictBriefService,
      inject: [RAW_DISTRICT_BRIEF_SERVICE, ContextCompilerService],
    },
  ],
})
export class DistrictBriefModule {}
