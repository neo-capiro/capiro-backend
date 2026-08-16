import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3DraftApprovalService } from './outreach-v3-draft-approval.service.js';
import { OutreachV3DraftsController } from './outreach-v3-drafts.controller.js';
import { OutreachV3DraftsGuard } from './outreach-v3-drafts.guard.js';

@Module({
  imports: [EngagementModule, PrismaModule, OutreachV3StateModule],
  controllers: [OutreachV3DraftsController],
  providers: [OutreachV3DraftApprovalService, OutreachV3DraftsGuard],
  exports: [OutreachV3DraftApprovalService, OutreachV3DraftsGuard],
})
export class OutreachV3DraftsModule {}
