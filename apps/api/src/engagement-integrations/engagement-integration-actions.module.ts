import { Module } from '@nestjs/common';
import { EngagementModule } from '../engagement/engagement.module.js';
import { MicrosoftIntegrationActionsController } from '../engagement/microsoft/microsoft-integration-actions.controller.js';
import { GoogleIntegrationActionsController } from '../engagement/google/google-integration-actions.controller.js';

/** Authenticated user-initiated integration actions, independently composable. */
@Module({
  imports: [EngagementModule],
  controllers: [MicrosoftIntegrationActionsController, GoogleIntegrationActionsController],
})
export class EngagementIntegrationActionsModule {}
