import { Module } from '@nestjs/common';
import { MeriModule } from '../meri/meri.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ContextModule } from '../context/context.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WorkspaceAssistantController } from './workspace-assistant.controller.js';
import { WorkspaceAssistantService } from './workspace-assistant.service.js';
import { MeriV2OrchestratorClient } from './meriv2-orchestrator.client.js';

/**
 * In-editor Meri assistant. Reuses MeriToolsService (read-only subset) from the
 * MeriModule, the per-tenant AI key resolver from the EngagementModule, and the
 * shared Context Compiler from the ContextModule (so the legacy editor path
 * grounds in the SAME institutional packet as the MeriV2 path); owns only the
 * bounded document-scoped loop + the /api/workspace/assistant route.
 */
@Module({
  imports: [MeriModule, EngagementModule, ContextModule, PrismaModule],
  controllers: [WorkspaceAssistantController],
  providers: [WorkspaceAssistantService, MeriV2OrchestratorClient],
})
export class WorkspaceAssistantModule {}
