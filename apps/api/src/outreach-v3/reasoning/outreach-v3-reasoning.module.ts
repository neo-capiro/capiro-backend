import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachReasoningExceptionFilter } from './outreach-reasoning-exception.filter.js';
import { OutreachReasoningHistoryService } from './outreach-reasoning-history.service.js';
import { OutreachReasoningRepository } from './outreach-reasoning.repository.js';
import { OutreachReasoningService } from './outreach-reasoning.service.js';
import { OutreachV3ReasoningController } from './outreach-v3-reasoning.controller.js';
import { OutreachV3ReasoningGuard } from './outreach-v3-reasoning.guard.js';

@Module({
  imports: [PrismaModule],
  controllers: [OutreachV3ReasoningController],
  providers: [
    OutreachReasoningRepository,
    OutreachReasoningHistoryService,
    OutreachReasoningService,
    OutreachV3ReasoningGuard,
    OutreachReasoningExceptionFilter,
  ],
})
export class OutreachV3ReasoningModule {}
