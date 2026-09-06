import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RepresentationResolverService } from '../clients/representation-resolver.service.js';
import { ClientPeRelevanceService } from '../intelligence/client-pe-relevance.service.js';
import { DistrictNexusService } from '../district-nexus/district-nexus.service.js';
import { DistrictNexusStrategicService } from '../district-nexus/district-nexus-strategic.service.js';
import { DistrictNexusEconomicService } from '../district-nexus/district-nexus-economic.service.js';
import { DistrictNexusPriorityIntelligenceService } from '../district-nexus/priority-intelligence/priority-intelligence.service.js';
import { DistrictNexusFlagGuard } from '../district-nexus/district-nexus-flag.guard.js';
import { DistrictNexusStrategicFlagGuard } from '../district-nexus/district-nexus-strategic-flag.guard.js';
import { DistrictNexusEconomicFlagGuard } from '../district-nexus/district-nexus-economic-flag.guard.js';
import { DistrictNexusPriorityIntelligenceFlagGuard } from '../district-nexus/priority-intelligence/priority-intelligence-flag.guard.js';
import { ActionRecommendationsRetrievalAdapter } from './adapters/action-recommendations-retrieval.adapter.js';
import { HearingsRetrievalAdapter } from './adapters/hearings-retrieval.adapter.js';
import { DistrictNexusRetrievalAdapter } from './adapters/district-nexus-retrieval.adapter.js';

/** Domain readers only: importing IntelligenceModule here would create a RetrievalModule cycle. */
@Module({
  imports: [PrismaModule, ConfigModule],
  providers: [
    RepresentationResolverService, ClientPeRelevanceService, DistrictNexusService, DistrictNexusStrategicService,
    DistrictNexusEconomicService, DistrictNexusPriorityIntelligenceService,
    DistrictNexusFlagGuard, DistrictNexusStrategicFlagGuard, DistrictNexusEconomicFlagGuard,
    DistrictNexusPriorityIntelligenceFlagGuard,
    ActionRecommendationsRetrievalAdapter, HearingsRetrievalAdapter, DistrictNexusRetrievalAdapter,
  ],
  exports: [ActionRecommendationsRetrievalAdapter, HearingsRetrievalAdapter, DistrictNexusRetrievalAdapter],
})
export class GovernmentWorkRetrievalModule {}
