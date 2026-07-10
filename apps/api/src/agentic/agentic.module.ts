import { Module } from '@nestjs/common';
import { RepresentationModule } from '../clients/representation.module.js';
import { ChokepointModule } from '../intelligence/chokepoint/chokepoint.module.js';
import { TargetingValidatorService } from './targeting-validator.service.js';
import { TargetingBriefService } from './targeting-brief.service.js';

/**
 * Agentic Tier-1/Tier-2 prerequisites + modes (Phase 1 M5.0-M5.2). Standalone
 * module (not folded into intelligence/clients) since M5.1's
 * `run-intel-workflows` worker is the only planned consumer so far.
 */
@Module({
  imports: [RepresentationModule, ChokepointModule],
  providers: [TargetingValidatorService, TargetingBriefService],
  exports: [TargetingValidatorService, TargetingBriefService],
})
export class AgenticModule {}
