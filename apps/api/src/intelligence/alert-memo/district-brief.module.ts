import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { ContextModule } from '../../context/context.module.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { ReviewsModule } from '../../reviews/reviews.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RepresentationModule } from '../../clients/representation.module.js';
import { DistrictBriefController } from './district-brief.controller.js';
import { DistrictBriefService } from './district-brief.service.js';
import {
  createGovernedDistrictBriefService,
  RAW_DISTRICT_BRIEF_SERVICE,
} from './governed-alert-deliverables.factory.js';

/**
 * District-impact one-pager (Phase 1 M1.5, PD6). Standalone module, sibling
 * to AlertMemoModule:
 *   - PrismaModule → the facility lookup + global CongressCommittee(Membership) tables
 *   - RepresentationModule → RepresentationResolverService (M1.3's deterministic join)
 *   - EngagementModule → EngagementService (Documents auto-file) + AiCredentialResolverService
 *   - ContextModule -> ContextCompilerService (client Memory files as steering, G1)
 */
@Module({
  imports: [PrismaModule, RepresentationModule, EngagementModule, ContextModule, ReviewsModule],
  controllers: [DistrictBriefController],
  providers: [
    { provide: RAW_DISTRICT_BRIEF_SERVICE, useClass: DistrictBriefService },
    {
      provide: DistrictBriefService,
      useFactory: createGovernedDistrictBriefService,
      inject: [RAW_DISTRICT_BRIEF_SERVICE, ContextCompilerService],
    },
  ],
})
export class DistrictBriefModule {}
