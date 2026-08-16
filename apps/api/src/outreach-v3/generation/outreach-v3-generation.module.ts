import { Module } from '@nestjs/common';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3ArtifactRootService } from '../drafts/outreach-v3-artifact-root.service.js';
import { OutreachV3ApproachApprovalService } from './outreach-v3-approach-approval.service.js';
import { OutreachV3FullGenerationGuard } from './outreach-v3-full-generation.guard.js';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';
import { OutreachV3GenerationController } from './outreach-v3-generation.controller.js';
import { OutreachV3GenerationGuard } from './outreach-v3-generation.guard.js';
import { OutreachV3GenerationPreparationService } from './outreach-v3-generation-preparation.service.js';
import { OutreachV3GenerationService } from './outreach-v3-generation.service.js';
import { OutreachV3SampleGenerationService } from './outreach-v3-sample-generation.service.js';

@Module({
  imports: [CapabilitiesModule, EngagementModule, PrismaModule, OutreachV3StateModule],
  controllers: [OutreachV3GenerationController],
  providers: [
    OutreachV3ArtifactRootService,
    OutreachV3ApproachApprovalService,
    OutreachV3FullGenerationGuard,
    OutreachV3FullGenerationService,
    OutreachV3GenerationGuard,
    OutreachV3GenerationPreparationService,
    OutreachV3GenerationService,
    OutreachV3SampleGenerationService,
  ],
  exports: [
    OutreachV3ArtifactRootService,
    OutreachV3ApproachApprovalService,
    OutreachV3FullGenerationService,
    OutreachV3GenerationPreparationService,
    OutreachV3GenerationService,
    OutreachV3SampleGenerationService,
  ],
})
export class OutreachV3GenerationModule {}
