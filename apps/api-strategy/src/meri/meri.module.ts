import { Module } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { FirmPhasesModule } from '../firm-phases/firm-phases.module.js';
import { ReferenceModule } from '../reference/reference.module.js';
import { ContextModule } from '../context/context.module.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import { StrategyConversationService } from './strategy-conversation.service.js';

/**
 * Strategy Planner Meri (G5). PrismaService + FlagsModule (guards) + ConfigModule
 * are @Global; VersioningService is stateless so provided locally (parity with
 * StrategyModule). The resolver + orchestrator client own the D19 creds hop.
 * ContextModule exports the Stage E StewardService — draft/assistant forward
 * stewardFacts + stewardHealth from it (wire-contract 2).
 */
@Module({
  imports: [FirmPhasesModule, ReferenceModule, ContextModule],
  controllers: [MeriController],
  providers: [
    MeriService,
    VersioningService,
    StrategyAiCredentialResolver,
    StrategyAttachmentResolver,
    StrategyOrchestratorClient,
    StrategyConversationService,
  ],
  // Stage C: AgentsModule replays ChangeSet ops through MeriService.applyEditSet.
  // Phase 4 will append Watch-acceptance messages via StrategyConversationService.
  exports: [MeriService, StrategyConversationService],
})
export class MeriModule {}
