import { Module } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { MeriService } from './meri.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';

/**
 * Strategy Planner Meri (G5). PrismaService + FlagsModule (guards) + ConfigModule
 * are @Global; VersioningService is stateless so provided locally (parity with
 * StrategyModule). The resolver + orchestrator client own the D19 creds hop.
 */
@Module({
  controllers: [MeriController],
  providers: [
    MeriService,
    VersioningService,
    StrategyAiCredentialResolver,
    StrategyOrchestratorClient,
  ],
})
export class MeriModule {}
