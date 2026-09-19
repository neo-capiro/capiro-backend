import { Module } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { FirmPhasesModule } from '../firm-phases/firm-phases.module.js';
import { ReferenceModule } from '../reference/reference.module.js';
import { ContextModule } from '../context/context.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import { StrategyConversationService } from './strategy-conversation.service.js';
import { StrategyContextPlaneClient } from './strategy-context-plane.client.js';
import { DraftJobService } from './draft-job.service.js';
import { DraftJobWorkerService } from './draft-job-worker.service.js';
import {
  createGovernedStrategyMeriService,
  RAW_STRATEGY_MERI_SERVICE,
} from './governed-strategy-meri.factory.js';

/**
 * Strategy Planner Meri. The raw service retains the mature Strategy mutation,
 * verifier, versioning and conversation pipeline. The exported MeriService is a
 * thin governed wrapper that resolves one shared Context Plane bundle before
 * every draft/edit/document reasoning call.
 */
@Module({
  imports: [FirmPhasesModule, ReferenceModule, ContextModule],
  controllers: [MeriController],
  providers: [
    VersioningService,
    StrategyAiCredentialResolver,
    StrategyAttachmentResolver,
    StrategyOrchestratorClient,
    StrategyConversationService,
    StrategyContextPlaneClient,
    DraftJobService,
    DraftJobWorkerService,
    {
      provide: RAW_STRATEGY_MERI_SERVICE,
      useClass: MeriService,
    },
    {
      provide: MeriService,
      useFactory: createGovernedStrategyMeriService,
      inject: [RAW_STRATEGY_MERI_SERVICE, StrategyContextPlaneClient, PrismaService],
    },
  ],
  // AgentsModule replays ChangeSet ops through the same governed service. The
  // non-reasoning apply/verify methods pass through unchanged.
  exports: [MeriService, StrategyConversationService],
})
export class MeriModule {}
