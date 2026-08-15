import { Module } from '@nestjs/common';
import { DocumentAgentService } from './document-agent.service.js';
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

@Module({
  imports: [WorkspaceReasoningModule, GenerationModule, CollaboratorsModule, ChecksModule],
  providers: [
    DocumentAgentService,
    DocumentAgentContextService,
    DocumentAgentOutlineService,
    DocumentAgentRevisionService,
    DocumentAgentQualityService,
  ],
  controllers: [
    DocumentAgentCatalogController,
    DocumentAgentController,
    AgentContextItemController,
  ],
  exports: [DocumentAgentService, DocumentAgentQualityService],
})
export class DocumentAgentModule {}
