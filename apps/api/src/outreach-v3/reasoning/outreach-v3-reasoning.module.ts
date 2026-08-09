import { Module } from '@nestjs/common';
import { AiCredentialsModule } from '../../ai-credentials/ai-credentials.module.js';
import { CapabilitiesModule } from '../../capabilities/capabilities.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { OutreachV3StateModule } from '../api/outreach-v3-state.module.js';
import { OpenAiOutreachReasoningProvider } from './openai-outreach-reasoning.provider.js';
import { OutreachReasoningContextService } from './outreach-reasoning-context.service.js';
import { OutreachReasoningExceptionFilter } from './outreach-reasoning-exception.filter.js';
import { OutreachReasoningHistoryService } from './outreach-reasoning-history.service.js';
import { OutreachReasoningRepository } from './outreach-reasoning.repository.js';
import { OutreachReasoningService } from './outreach-reasoning.service.js';
import { OutreachReasoningTurnClaimService } from './outreach-reasoning-turn-claim.service.js';
import { OutreachV3ReasoningController } from './outreach-v3-reasoning.controller.js';
import { OutreachV3ReasoningGuard } from './outreach-v3-reasoning.guard.js';

@Module({
  imports: [
    PrismaModule,
    AiCredentialsModule,
    CapabilitiesModule,
    OutreachV3StateModule,
  ],
  controllers: [OutreachV3ReasoningController],
  providers: [
    OpenAiOutreachReasoningProvider,
    OutreachReasoningRepository,
    OutreachReasoningTurnClaimService,
    OutreachReasoningContextService,
    OutreachReasoningHistoryService,
    OutreachReasoningService,
    OutreachV3ReasoningGuard,
    OutreachReasoningExceptionFilter,
  ],
})
export class OutreachV3ReasoningModule {}
