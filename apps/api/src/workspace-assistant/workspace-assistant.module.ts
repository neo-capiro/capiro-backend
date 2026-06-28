import { Module } from '@nestjs/common';
import { MeriModule } from '../meri/meri.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { WorkspaceAssistantController } from './workspace-assistant.controller.js';
import { WorkspaceAssistantService } from './workspace-assistant.service.js';

/**
 * In-editor Meri assistant. Reuses MeriToolsService (read-only subset) from the
 * MeriModule and the per-tenant AI key resolver from the EngagementModule; owns
 * only the bounded document-scoped loop + the /api/workspace/assistant route.
 */
@Module({
  imports: [MeriModule, EngagementModule],
  controllers: [WorkspaceAssistantController],
  providers: [WorkspaceAssistantService],
})
export class WorkspaceAssistantModule {}
