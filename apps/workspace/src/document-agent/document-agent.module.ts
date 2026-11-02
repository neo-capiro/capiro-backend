import { Module } from '@nestjs/common';
import { DocumentAgentService } from './document-agent.service.js';
import {
  NATIVE_GENERATION_TURN,
  type NativeGenerationTurnPort,
} from './native-generation.bridge.js';
import { nativeGenerationClientFromEnvironment } from './native-generation-conversation.client.js';
import {
  DocumentAgentCatalogController,
  DocumentAgentController,
  AgentContextItemController,
} from './document-agent.controller.js';
import { DocumentAgentContextService } from './document-agent-context.service.js';
import { DocumentAgentOutlineService } from './document-agent-outline.service.js';
import { DocumentAgentRevisionService } from './document-agent-revision.service.js';
import { DocumentAgentQualityService } from './document-agent-quality.service.js';
import { WorkspaceReasoningModule } from '../workspace-reasoning/workspace-reasoning.module.js';
import { GenerationModule } from '../generation/generation.module.js';
import { CollaboratorsModule } from '../collaborators/collaborators.module.js';
import { ChecksModule } from '../checks/checks.module.js';
import { ProspectGenerationService } from './prospect-generation/prospect-generation.service.js';
import { ProspectGenerationController } from './prospect-generation/prospect-generation.controller.js';
import { ProspectGenerationBootstrapClient } from './prospect-generation/bootstrap.client.js';

@Module({
  imports: [WorkspaceReasoningModule, GenerationModule, CollaboratorsModule, ChecksModule],
  providers: [
    // The approved greenfield Meri native conversation owner. It is the ONE
    // production caller of a supported generated phase; when the deployment does
    // not configure it, the token resolves to null and every phase answers an
    // explicit 503 instead of falling back to the retired legacy owners.
    {
      provide: NATIVE_GENERATION_TURN,
      useFactory: (): NativeGenerationTurnPort | null => nativeGenerationClientFromEnvironment(),
    },
    DocumentAgentService,
    DocumentAgentContextService,
    DocumentAgentOutlineService,
    DocumentAgentRevisionService,
    DocumentAgentQualityService,
    ProspectGenerationService,
    ProspectGenerationBootstrapClient,
  ],
  controllers: [
    DocumentAgentCatalogController,
    DocumentAgentController,
    AgentContextItemController,
    ProspectGenerationController,
  ],
  exports: [DocumentAgentService, DocumentAgentQualityService],
})
export class DocumentAgentModule {}
