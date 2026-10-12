import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ClientsController } from './clients.controller.js';
import { ClientsService } from './clients.service.js';
import { ClientCapabilitiesController } from './client-capabilities.controller.js';
import { ClientCapabilitiesService } from './client-capabilities.service.js';
import { ClientPeopleController } from './client-people.controller.js';
import { ClientPeopleService } from './client-people.service.js';
import { ClientFacilitiesController } from './client-facilities.controller.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { ClientTargetsController } from './client-targets.controller.js';
import { ClientTargetsService } from './client-targets.service.js';
import { ClientTargetRecommendationsController } from './client-target-recommendations.controller.js';
import { ClientTargetRecommendationsService } from './client-target-recommendations.service.js';
import { ClientCapabilityFitController } from './client-capability-fit.controller.js';
import { ClientCapabilityFitService } from './client-capability-fit.service.js';
import { ClientFilesController, ClientFilesService } from './client-files.controller.js';
import { ClientActivityController } from './client-activity.controller.js';
import { ClientActivityService } from './client-activity.service.js';
import { ClientProfileFillController } from './client-profile-fill.controller.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { ClientProfileFillContextPlaneService } from './client-profile-fill-context-plane.service.js';
import { ClientProfileFillWorkflowService } from './client-profile-fill-workflow.service.js';
import { ClientProfileFillRelationshipHistoryService } from './client-profile-fill-relationship-history.service.js';
import { ClientProfileFillCompletionService } from './client-profile-fill-completion.service.js';
import { ClientAdvocacyMatterController } from './client-advocacy-matter.controller.js';
import { ClientAdvocacyMatterService } from './client-advocacy-matter.service.js';
import { AdvocacyHistoryHierarchyInterceptor } from './advocacy-history-hierarchy.interceptor.js';
import { AdvocacyHistoryPresentationInterceptor } from './advocacy-history-presentation.interceptor.js';
import {
  createGovernedClientProfileFillService,
  RAW_CLIENT_PROFILE_FILL_SERVICE,
} from './governed-client-profile-fill.factory.js';
import { ClientAccountOwnerController } from './client-account-owner.controller.js';
import { ClientAccountOwnerService } from './client-account-owner.service.js';
import { ClientTeamController } from './client-team.controller.js';
import { ClientTeamService } from './client-team.service.js';
import { ClientObjectivesModule } from './objectives/objectives.module.js';
import { InternalClientBrandingController } from './internal-client-branding.controller.js';
import { RepresentationModule } from './representation.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { ContextModule } from '../context/context.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { QualityTelemetryModule } from '../quality-telemetry/quality-telemetry.module.js';
import { EvaluationModule } from '../evaluation/evaluation.module.js';
import { CrmFillEvaluationRunner } from './crm-fill-evaluation.runner.js';
import { TrackerModule } from '../tracker/tracker.module.js';
import { FundingOpportunitiesModule } from '../funding-opportunities/funding-opportunities.module.js';

@Module({
  // RepresentationModule (not folded in here) so DirectoryModule can ALSO
  // depend on it without a cycle — ClientsModule already imports
  // DirectoryModule for the Facilities tab's directory cross-links.
  // TrackerModule exports TrackerService for capability-fit bill projection
  // (Phase B). FundingOpportunitiesModule exports canonical FundingOpportunityV2 services
  // for FO projection (Phase C). Cycle risk verified none: TrackerModule only
  // imports IntelligenceModule + EngagementModule; FO module imports MemoryModule.
  imports: [
    ClientObjectivesModule,
    EmbeddingsModule,
    IntelligenceModule,
    DirectoryModule,
    RepresentationModule,
    ContextModule,
    LearningModule,
    QualityTelemetryModule,
    EvaluationModule,
    // G3: OutcomeService for the submission-outcome mirror.
    EngagementModule,
    // Bill recommendations for Fill with Meri (getRecommendations).
    TrackerModule,
    FundingOpportunitiesModule,
  ],
  controllers: [
    ClientsController,
    ClientCapabilitiesController,
    ClientPeopleController,
    ClientFacilitiesController,
    ClientTargetsController,
    ClientTargetRecommendationsController,
    ClientCapabilityFitController,
    ClientProfileFillController,
    ClientAdvocacyMatterController,
    ClientActivityController,
    ClientFilesController,
    ClientAccountOwnerController,
    ClientTeamController,
    // Backend-only Hill Day co-branding bridge (InternalServiceGuard).
    InternalClientBrandingController,
  ],
  providers: [
    ClientsService,
    ClientCapabilitiesService,
    ClientPeopleService,
    ClientFacilitiesService,
    ClientTargetsService,
    ClientTargetRecommendationsService,
    ClientCapabilityFitService,
    ClientProfileFillContextPlaneService,
    ClientProfileFillRelationshipHistoryService,
    CrmFillEvaluationRunner,
    {
      provide: RAW_CLIENT_PROFILE_FILL_SERVICE,
      useClass: ClientProfileFillService,
    },
    {
      provide: ClientProfileFillService,
      useFactory: createGovernedClientProfileFillService,
      inject: [
        RAW_CLIENT_PROFILE_FILL_SERVICE,
        ClientProfileFillContextPlaneService,
        ClientPeopleService,
        CrmFillEvaluationRunner,
        ClientProfileFillRelationshipHistoryService,
      ],
    },
    // Restart-safe DB task worker and setup gate. It consumes the governed
    // ClientProfileFillService so specialist execution retains Context Plane,
    // evidence, review, and learning behavior.
    ClientProfileFillWorkflowService,
    // Completion facade + second durable ledger for the downstream specialists.
    // It keeps advanced task types isolated from the Phase 1-3 worker while
    // presenting one run/progress contract to the client-profile UI.
    ClientProfileFillCompletionService,
    // Advocacy Matter clustering/assignment + read API. Injected into the
    // completion service so applyAdvocacyRecord can assign a Matter in the
    // same transaction as the record upsert.
    ClientAdvocacyMatterService,
    // Register hierarchy BEFORE the existing presentation interceptor. Nest
    // response interceptors unwind in reverse order, so LDA issue-first
    // presentation runs first and this final pass can make the Matter title
    // the record headline while keeping Timeline entries event-shaped.
    {
      provide: APP_INTERCEPTOR,
      useClass: AdvocacyHistoryHierarchyInterceptor,
    },
    // Existing LDA rows retain their durable source title/status. This
    // read-side layer turns filing slugs into issue-first product copy only
    // on Advocacy Matter GET responses, so historical UI improves without a
    // migration or source-data rewrite.
    {
      provide: APP_INTERCEPTOR,
      useClass: AdvocacyHistoryPresentationInterceptor,
    },
    ClientActivityService,
    ClientFilesService,
    ClientAccountOwnerService,
    ClientTeamService,
  ],
  // Exported so Meri's get_client_context tool can read full client profiles
  // and update_client_profile can write approved values back.
  exports: [
    ClientsService,
    ClientCapabilitiesService,
    ClientPeopleService,
    ClientFacilitiesService,
    ClientTargetsService,
    ClientAdvocacyMatterService,
  ],
})
export class ClientsModule {}
