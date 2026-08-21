import { Module } from '@nestjs/common';
import { MeriModule } from '../meri/meri.module.js';
import { EngagementModule } from '../engagement/engagement.module.js';
import { ContextModule } from '../context/context.module.js';
import { ContextCompilerService } from '../context/context-compiler.service.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { WorkspaceAssistantController } from './workspace-assistant.controller.js';
import { WorkspaceAssistantService } from './workspace-assistant.service.js';
import { MeriV2OrchestratorClient } from './meriv2-orchestrator.client.js';
import { WorkspaceContextPlaneService } from './workspace-context-plane.service.js';
import { WorkspaceEditorContextCompilerAdapter } from './workspace-editor-context-compiler.adapter.js';
import { InternalWorkspaceContextController } from './internal-workspace-context.controller.js';

/**
 * In-editor Meri assistant. Phase 21 keeps the bounded document-scoped model,
 * tool and verifier loop, but replaces its context compiler dependency with the
 * shared Context Plane adapter. The internal controller is guarded by the
 * backend-only service secret and exists solely for apps/workspace.
 */
@Module({
  imports: [MeriModule, EngagementModule, ContextModule, PrismaModule],
  controllers: [WorkspaceAssistantController, InternalWorkspaceContextController],
  providers: [
    WorkspaceAssistantService,
    MeriV2OrchestratorClient,
    WorkspaceContextPlaneService,
    WorkspaceEditorContextCompilerAdapter,
    { provide: ContextCompilerService, useExisting: WorkspaceEditorContextCompilerAdapter },
  ],
})
export class WorkspaceAssistantModule {}
