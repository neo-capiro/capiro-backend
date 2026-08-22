import { Module } from '@nestjs/common';
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
import {
  createGovernedClientProfileFillService,
  RAW_CLIENT_PROFILE_FILL_SERVICE,
} from './governed-client-profile-fill.factory.js';
import { ClientAccountOwnerController } from './client-account-owner.controller.js';
import { ClientAccountOwnerService } from './client-account-owner.service.js';
import { ClientTeamController } from './client-team.controller.js';
import { ClientTeamService } from './client-team.service.js';
import { RepresentationModule } from './representation.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { DirectoryModule } from '../directory/directory.module.js';
import { ContextModule } from '../context/context.module.js';
import { LearningModule } from '../learning/learning.module.js';
import { TrackerModule } from '../tracker/tracker.module.js';
import { FundingOpportunitiesModule } from '../funding-opportunities/funding-opportunities.module.js';

@Module({
  // RepresentationModule (not folded in here) so DirectoryModule can ALSO
  // depend on it without a cycle — ClientsModule already imports
  // DirectoryModule for the Facilities tab's directory cross-links.
  // TrackerModule exports TrackerService for capability-fit bill projection
  // (Phase B). FundingOpportunitiesModule exports FundingOpportunitiesService
  // for FO projection (Phase C). Cycle risk verified none: TrackerModule only
  // imports IntelligenceModule + EngagementModule; FO module imports MemoryModule.
  imports: [
    EmbeddingsModule,
    IntelligenceModule,
    DirectoryModule,
    RepresentationModule,
    ContextModule,
    LearningModule,
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
    ClientActivityController,
    ClientFilesController,
    ClientAccountOwnerController,
    ClientTeamController,
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
      ],
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
  ],
})
export class ClientsModule {}
