import { Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';
import { OfficeRecommenderService } from './office-recommender.service.js';
import { InsightGeneratorService } from './insight-generator.service.js';
import { EntityResolutionService } from './entity-resolution.service.js';
import { ReportCardService } from './report-card.service.js';
import { ClientPeRelevanceService } from './client-pe-relevance.service.js';
import { ClientPeRelevanceController } from './client-pe-relevance.controller.js';
import { ActionRecommendationService } from './actions/action-recommendation.service.js';
import { ActionRecommendationReadService } from './actions/action-recommendation-read.service.js';
import { ActionRecommendationController } from './action-recommendation.controller.js';
import { ArtifactGeneratorService } from './artifacts/artifact-generator.service.js';
import { ArtifactController } from './artifacts/artifact.controller.js';
import { ProductMetricsService } from './metrics/product-metrics.service.js';
import { ProductMetricsController } from './metrics/product-metrics.controller.js';
import { TrustMetricsService } from './metrics/trust-metrics.service.js';
import { TrustMetricsController } from './metrics/trust-metrics.controller.js';
import { CoverageGapService } from './coverage/coverage-gap.service.js';
import { CoverageController } from './coverage/coverage.controller.js';
import { FirmOnboardingService } from './firm-onboarding.service.js';
import { FirmOnboardingController } from './firm-onboarding.controller.js';
import { ClientPrepopulationService } from './client-prepopulation.service.js';
import { SamEntityEnrichmentService } from './sam-entity.service.js';
import { LdaIntelModule } from '../lda-intel/lda-intel.module.js';
import { LobbyIntelModule } from '../lobby-intel/lobby-intel.module.js';
import { FederalSpendingModule } from '../federal-spending/federal-spending.module.js';
import { FederalRegisterModule } from '../federal-register/federal-register.module.js';
import { DirectoryModule } from '../directory/directory.module.js';

@Module({
  imports: [
    LdaIntelModule,
    LobbyIntelModule,
    FederalSpendingModule,
    FederalRegisterModule,
    DirectoryModule,
  ],
  controllers: [
    IntelligenceController,
    ClientPeRelevanceController,
    ActionRecommendationController,
    ArtifactController,
    ProductMetricsController,
    TrustMetricsController,
    CoverageController,
    FirmOnboardingController,
  ],
  providers: [
    IntelligenceService,
    OfficeRecommenderService,
    InsightGeneratorService,
    EntityResolutionService,
    FirmOnboardingService,
    ClientPrepopulationService,
    SamEntityEnrichmentService,
    ReportCardService,
    ClientPeRelevanceService,
    ActionRecommendationService,
    ActionRecommendationReadService,
    ArtifactGeneratorService,
    ProductMetricsService,
    TrustMetricsService,
    CoverageGapService,
  ],
  // ClientPeRelevanceService is EXPORTED so the program-element delta writer (Agent B)
  // and other modules can inject the cross-tenant relevance path without a DI cycle.
  // ActionRecommendationService (Step 3.2 generator) is EXPORTED so the action-card
  // CRUD API chunk (Agent B) can inject it for the manual "regenerate" endpoint.
  exports: [
    IntelligenceService,
    OfficeRecommenderService,
    InsightGeneratorService,
    EntityResolutionService,
    ReportCardService,
    ClientPeRelevanceService,
    ActionRecommendationService,
    // Exported so ClientsService (resolve-on-create) and FirmOnboardingService
    // (import) can run the prepopulation cascade.
    ClientPrepopulationService,
    // Exported so ClientsService (create) and FirmOnboardingService (import) can
    // fire-and-forget SAM gov-id enrichment.
    SamEntityEnrichmentService,
    // Exported so Meri's query_action_items tool can read Needs-Attention cards.
    ActionRecommendationReadService,
  ],
})
export class IntelligenceModule {}
