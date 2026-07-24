import { Module } from '@nestjs/common';
import { ContextController } from './context.controller.js';
import { StewardController } from './steward.controller.js';
import { ContextDocumentsService } from './context-documents.service.js';
import { CurrentPlanExportService } from './current-plan-export.service.js';
import { StewardService } from './steward.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';

/**
 * Stage D context module: context-pack document store (upload / supersession /
 * provenance locate) + the read-only current-plan projection. Stage E adds the
 * Context Steward (fact extraction / conflicts / health). VersioningService is
 * stateless so provided locally (house parity with AgentsModule/MeriModule);
 * PrismaService + FlagsModule (guards) + ConfigModule are @Global.
 *
 * StrategyOrchestratorClient + StrategyAiCredentialResolver are provided as
 * LOCAL instances (config-driven, no shared state worth preserving): importing
 * MeriModule for them would create a module cycle, since MeriModule imports
 * THIS module for the exported StewardService (draft/assistant forward
 * stewardFacts + stewardHealth).
 */
@Module({
  controllers: [ContextController, StewardController],
  providers: [
    ContextDocumentsService,
    CurrentPlanExportService,
    StewardService,
    VersioningService,
    StrategyAiCredentialResolver,
    StrategyOrchestratorClient,
  ],
  exports: [StewardService],
})
export class ContextModule {}
