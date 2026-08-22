import { Module } from '@nestjs/common';
import { RepresentationModule } from '../clients/representation.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { DistrictNexusController } from './district-nexus.controller.js';
import { DistrictNexusRelationshipsController } from './district-nexus-relationships.controller.js';
import { DistrictNexusEconomicController } from './district-nexus-economic.controller.js';
import { DistrictNexusService } from './district-nexus.service.js';
import { DistrictNexusRelationshipsService } from './district-nexus-relationships.service.js';
import { DistrictNexusStrategicService } from './district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from './district-nexus-economic.service.js';
import { DistrictNexusFlagGuard } from './district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from './district-nexus-strategic-flag.guard.js';
import { DistrictNexusEconomicFlagGuard } from './district-nexus-economic-flag.guard.js';

/**
 * District Nexus v2.
 *
 * Release 1 owns the verified footprint/truth layer. Release 2 adds a separate
 * Strategic Relevance rail. Release 3 adds reviewable first-party economic
 * evidence and public district context. These are registered in one module but
 * remain independently gated and independently scored — no parallel map or
 * blended master score.
 */
@Module({
  imports: [RepresentationModule, IntelligenceModule],
  controllers: [
    DistrictNexusController,
    DistrictNexusRelationshipsController,
    DistrictNexusEconomicController,
  ],
  providers: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
    DistrictNexusEconomicService,
    DistrictNexusFlagGuard,
    DistrictNexusStrategicFlagGuard,
    DistrictNexusEconomicFlagGuard,
  ],
  exports: [
    DistrictNexusService,
    DistrictNexusRelationshipsService,
    DistrictNexusStrategicService,
    DistrictNexusEconomicService,
  ],
})
export class DistrictNexusModule {}
