import { Module } from '@nestjs/common';
import { MeriController } from './meri.controller.js';
import { MeriRegistryService } from './meri-registry.service.js';
import { MeriContextResolver } from './meri-context.resolver.js';
import { OrchestratorContextCompilerService } from './context-compiler.service.js';
import { ApiClientContextRepo } from './api-client-context.repo.js';
import { ApiToolExecutorRepo } from './api-tool-executor.repo.js';
import { ApiApprovalRepo } from './api-approval.repo.js';
import { ApiComplianceAuditRepo } from './api-compliance-audit.repo.js';
import { ApiPendingActionRepo } from './api-pending-action.repo.js';
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

/**
 * Hosts the MeriV2 tool registry over HTTP at `/meri-api/tools/*` plus the
 * in-editor assistant surface at `/meri-api/in-editor-assistant` and the full
 * chat surface at `/meri-api/chat` (C4). Thin: all reasoning lives in
 * `@capiro/meriv2-core`; this module wires the data adapters (the api-delegating
 * client-context repo, the generic tool executor, the approval repo), the
 * in-editor + chat loops, and the tenant-scoped invocation path.
 */
@Module({
  controllers: [
    MeriController,
    InEditorController,
    ChatController,
    WorkspaceGenController,
    StrategyController,
    StewardController,
  ],
  providers: [
    // PrismaService is NOT listed here: it now comes from the @Global
    // PrismaModule. Re-providing it locally would create a second
    // PrismaClient and a second connection pool.
    MeriContextResolver,
    OrchestratorContextCompilerService,
    ApiClientContextRepo,
    ApiToolExecutorRepo,
    ApiApprovalRepo,
    ApiComplianceAuditRepo,
    ApiPendingActionRepo,
    MeriRegistryService,
    InEditorAssistantService,
    ChatAssistantService,
    WorkspaceGenClient,
    StrategyAssistantService,
    StrategyContextPackService,
    StewardExtractService,
  ],
})
export class MeriModule {}
