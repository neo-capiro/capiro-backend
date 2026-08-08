import { Module } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { MeriRegistryService } from './meri-registry.service.js';
import { MeriContextResolver } from './meri-context.resolver.js';
import { OrchestratorContextCompilerService } from './context-compiler.service.js';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiActionProposalRepo } from './api-action-proposal.repo.js';
import { ApiComplianceAuditRepo } from './api-compliance-audit.repo.js';
import { InEditorController } from './in-editor/in-editor.controller.js';
import { InEditorAssistantService } from './in-editor/in-editor-assistant.service.js';
import { ChatController } from './chat/chat.controller.js';
import { ChatAssistantService } from './chat/chat-assistant.service.js';
import { WorkspaceGenController } from './workspace-gen/workspace-gen.controller.js';
import { WorkspaceGenClient } from './workspace-gen/workspace-gen.client.js';
import { StrategyController } from './strategy/strategy.controller.js';
import { StrategyAssistantService } from './strategy/strategy-assistant.service.js';
import { StrategyContextPackService } from './strategy/strategy-context-pack.service.js';
import { StewardController } from './steward/steward.controller.js';
import { StewardExtractService } from './steward/steward-extract.service.js';
import { MeriV3Controller } from './meriv3/meriv3.controller.js';
import { MeriV3AccessService } from './meriv3/meriv3-access.service.js';
import { MeriV3AssistantService } from './meriv3/meriv3-assistant.service.js';
import { MeriV3ManagedMcpAssistantService } from './meriv3/meriv3-managed-mcp-assistant.service.js';
import { ApiManagedMcpRepo } from './meriv3/api-managed-mcp.repo.js';
import { ApiVisualAnalysisRepo } from './meriv3/api-visual-analysis.repo.js';
import { OpenAiResponsesClient } from './meriv3/openai-responses.client.js';

/**
 * Hosts the isolated Meri runtime service. MeriV2 remains the established
 * surface at `/meri-api/chat`; MeriV3 is a separate, fail-closed canary at
 * `/meri-api/v3/chat`, sharing Capiro's governed registry, context compiler,
 * action authority and audit stores without replacing Workspace, in-editor,
 * Strategy or Steward generation.
 */
@Module({
  controllers: [
    MeriController,
    InEditorController,
    ChatController,
    MeriV3Controller,
    WorkspaceGenController,
    StrategyController,
    StewardController,
  ],
  providers: [
    // PrismaService is NOT listed here: it comes from the @Global PrismaModule.
    // Re-providing it would create a second PrismaClient and connection pool.
    MeriContextResolver,
    OrchestratorContextCompilerService,
    ApiClientContextRepo,
    ApiToolExecutorRepo,
    ApiActionProposalRepo,
    ApiComplianceAuditRepo,
    MeriRegistryService,
    InEditorAssistantService,
    ChatAssistantService,
    MeriV3AccessService,
    OpenAiResponsesClient,
    ApiManagedMcpRepo,
    ApiVisualAnalysisRepo,
    {
      provide: MeriV3AssistantService,
      useClass: MeriV3ManagedMcpAssistantService,
    },
    WorkspaceGenClient,
    StrategyAssistantService,
    StrategyContextPackService,
    StewardExtractService,
  ],
})
export class MeriModule {}
