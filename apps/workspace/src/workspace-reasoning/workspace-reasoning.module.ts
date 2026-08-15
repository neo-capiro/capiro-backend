import { Module } from '@nestjs/common';
import { WorkspaceReasoningGateway } from './workspace-reasoning.gateway.js';

/**
 * Workspace Reasoning module — provides the WorkspaceReasoningGateway to the
 * document-agent and other services that need structured model calls. The
 * gateway is a narrow HTTP client to the MeriV3 reasoning orchestrator.
 */
@Module({
  providers: [WorkspaceReasoningGateway],
  exports: [WorkspaceReasoningGateway],
})
export class WorkspaceReasoningModule {}
