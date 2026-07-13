import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { ContextModule } from '../../context/context.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { RepresentationModule } from '../../clients/representation.module.js';
import { DistrictBriefController } from './district-brief.controller.js';
import { DistrictBriefService } from './district-brief.service.js';

/**
 * District-impact one-pager (Phase 1 M1.5, PD6). Standalone module, sibling
 * to AlertMemoModule:
 *   - PrismaModule → the facility lookup + global CongressCommittee(Membership) tables
 *   - RepresentationModule → RepresentationResolverService (M1.3's deterministic join)
 *   - EngagementModule → EngagementService (Documents auto-file) + AiCredentialResolverService
 *   - ContextModule -> ContextCompilerService (client Memory files as steering, G1)
 */
@Module({
  imports: [PrismaModule, RepresentationModule, EngagementModule, ContextModule],
  controllers: [DistrictBriefController],
  providers: [DistrictBriefService],
})
export class DistrictBriefModule {}
