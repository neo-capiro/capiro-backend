import { Module } from '@nestjs/common';
import { EngagementModule } from '../../engagement/engagement.module.js';
import { AttachmentContentService } from '../../engagement/attachment-content.service.js';
import { AttachmentScannerService } from '../../engagement/attachment-scanner.service.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OutreachV3DraftsModule } from '../drafts/outreach-v3-drafts.module.js';
import { OutreachV3GenerationModule } from '../generation/outreach-v3-generation.module.js';
import { OutreachV3SendController } from './outreach-v3-send.controller.js';
import { OutreachV3SendGuard } from './outreach-v3-send.guard.js';
import { OutreachV3SendService } from './outreach-v3-send.service.js';

@Module({
  imports: [
    EngagementModule,
    PrismaModule,
    OutreachV3StateModule,
    OutreachV3GenerationModule,
    OutreachV3DraftsModule,
  ],
  controllers: [OutreachV3SendController],
  providers: [
    AttachmentContentService,
    AttachmentScannerService,
    OutreachV3SendGuard,
    OutreachV3SendService,
  ],
  exports: [OutreachV3SendService],
})
export class OutreachV3SendModule {}
