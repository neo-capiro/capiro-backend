import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AiCredentialsModule } from '../ai-credentials/ai-credentials.module.js';
import { LlmCompletionService } from '../engagement/llm-completion.service.js';
import { BillImpactController } from './bill-impact.controller.js';
import { BillImpactService } from './bill-impact.service.js';
@Module({
  imports: [PrismaModule, AiCredentialsModule],
  controllers: [BillImpactController],
  providers: [
    BillImpactService,
    { provide: LlmCompletionService, useFactory: () => new LlmCompletionService() },
  ],
})
export class BillImpactModule {}
