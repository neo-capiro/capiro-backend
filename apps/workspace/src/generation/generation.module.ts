import { Module } from '@nestjs/common';
import { GenerationController, MeriIntakeController } from './generation.controller.js';
import { GenerationService } from './generation.service.js';
import { AiCredentialService } from './ai-credential.service.js';
import { PeResolverService } from './pe-resolver.service.js';
import { MeriV2FlagsService } from '../meriv2/meriv2-flags.service.js';
import { MeriV2OrchestratorClient } from '../meriv2/meriv2-orchestrator.client.js';
import { MemoryPromotionClient } from './memory-promotion.client.js';
import { MemoryPromotionService } from './memory-promotion.service.js';

@Module({
  controllers: [GenerationController, MeriIntakeController],
  providers: [
    GenerationService,
    AiCredentialService,
    PeResolverService,
    MeriV2FlagsService,
    MeriV2OrchestratorClient,
    MemoryPromotionClient,
    MemoryPromotionService,
  ],
  exports: [GenerationService, AiCredentialService],
})
export class GenerationModule {}
