import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3ApproachApprovalService } from './outreach-v3-approach-approval.service.js';
import { OutreachV3FullGenerationGuard } from './outreach-v3-full-generation.guard.js';
import { OutreachV3FullGenerationService } from './outreach-v3-full-generation.service.js';
import { OutreachV3GenerationController } from './outreach-v3-generation.controller.js';
import { OutreachV3GenerationGuard } from './outreach-v3-generation.guard.js';
import { OutreachV3GenerationService } from './outreach-v3-generation.service.js';

@Module({
  imports: [EngagementModule, PrismaModule, OutreachV3StateModule],
  controllers: [OutreachV3GenerationController],
  providers: [
    OutreachV3ApproachApprovalService,
    OutreachV3FullGenerationGuard,
    OutreachV3FullGenerationService,
    OutreachV3GenerationGuard,
    OutreachV3GenerationService,
  ],
  exports: [
    OutreachV3ApproachApprovalService,
    OutreachV3FullGenerationService,
    OutreachV3GenerationService,
  ],
})
export class OutreachV3GenerationModule {}
