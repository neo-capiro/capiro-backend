import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3GenerationModule } from '../generation/outreach-v3-generation.module.js';
import { OutreachV3DraftApprovalService } from './outreach-v3-draft-approval.service.js';
import { OutreachV3DraftRefineService } from './outreach-v3-draft-refine.service.js';
import { OutreachV3DraftsController } from './outreach-v3-drafts.controller.js';
import { OutreachV3DraftsGuard } from './outreach-v3-drafts.guard.js';

@Module({
  // Refine reuses the generation module's already-exported artifact-root and
  // slot-reauthorization seams rather than re-providing them, so one campaign
  // has exactly one artifact parent and one reauthorization path.
  imports: [EngagementModule, PrismaModule, OutreachV3StateModule, OutreachV3GenerationModule],
  controllers: [OutreachV3DraftsController],
  providers: [OutreachV3DraftApprovalService, OutreachV3DraftRefineService, OutreachV3DraftsGuard],
  exports: [OutreachV3DraftApprovalService, OutreachV3DraftRefineService, OutreachV3DraftsGuard],
})
export class OutreachV3DraftsModule {}
