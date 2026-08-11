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
import { ClientProfileFillController } from './client-profile-fill.controller.js';
import { ClientProfileFillService } from './client-profile-fill.service.js';
import { RepresentationModule } from './representation.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { EmbeddingsModule } from '../embeddings/embeddings.module.js';
import { IntelligenceModule } from '../intelligence/intelligence.module.js';
import { DirectoryModule } from '../directory/directory.module.js';

@Module({
  // RepresentationModule (not folded in here) so DirectoryModule can ALSO
  // depend on it without a cycle — ClientsModule already imports
  // DirectoryModule for the Facilities tab's directory cross-links.
  imports: [
    EmbeddingsModule,
    IntelligenceModule,
    DirectoryModule,
    RepresentationModule,
    // G3: OutcomeService for the submission-outcome mirror.
    EngagementModule,
  ],
  controllers: [
    ClientsController,
    ClientCapabilitiesController,
    ClientPeopleController,
    ClientFacilitiesController,
    ClientTargetsController,
    ClientTargetRecommendationsController,
    ClientProfileFillController,
  ],
  providers: [
    ClientsService,
    ClientCapabilitiesService,
    ClientPeopleService,
    ClientFacilitiesService,
    ClientTargetsService,
    ClientTargetRecommendationsService,
    ClientProfileFillService,
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
