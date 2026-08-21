import { Injectable } from '@nestjs/common';
import type { CompiledContextPacket, ContextRequest, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import { WorkspaceContextPlaneService } from './workspace-context-plane.service.js';

type WorkspaceGovernedPacket = CompiledContextPacket & {
  /** Runtime-only projection; never part of the persisted packet. */
  governedContext?: Pick<MeriGovernedTurnContext, 'prompt'>;
  /** Runtime-only bounded Retrieval V2 evidence; never persisted. */
  supplementalEvidence?: string;
};

/**
 * Compatibility adapter for the in-process editor assistant.
 *
 * WorkspaceAssistantService still depends on the historical ContextCompilerService
 * token. Phase 21 overrides that token in WorkspaceAssistantModule with this
 * adapter, so the live path now crosses ContextPlaneGatewayService without a
 * broad rewrite of the editor's model/tool/verifier loop.
 */
@Injectable()
export class WorkspaceEditorContextCompilerAdapter {
  constructor(private readonly contextPlane: WorkspaceContextPlaneService) {}

  async compile(req: ContextRequest): Promise<WorkspaceGovernedPacket> {
    const actorUserId = req.actorUserId ?? req.userId;
    if (!actorUserId) throw new Error('workspace_editor_context_actor_required');
    const documentId =
      typeof req.ref?.documentId === 'string' && req.ref.documentId.trim()
        ? req.ref.documentId
        : null;
    const result = await this.contextPlane.resolveForActor(
      { tenantId: req.tenantId, userId: actorUserId },
      {
        operationId: 'workspace.editor-assist',
        surface: 'workspace-editor',
        task: 'Assist with the current Workspace document using governed context.',
        clientId: req.clientId ?? null,
        documentId,
        traceId: req.traceId ?? null,
        requestId: documentId,
        ref: req.ref,
      },
    );
    return Object.assign(result.packet, {
      governedContext: { prompt: result.governedContext.prompt },
      supplementalEvidence: result.supplementalEvidence,
    });
  }
}
