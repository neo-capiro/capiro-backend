import { Injectable } from '@nestjs/common';
import type {
  CompiledContextPacket,
  ContextRequest,
} from '@capiro/meriv2-core/context/contract';
import type { MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  clearContextPersistenceHold,
  markContextPersistenceHold,
} from './context-persistence-hold.js';

type WorkspaceOperation = 'workspace.generate' | 'workspace.editor-assist';

interface CompileResponse {
  packet?: CompiledContextPacket;
  governedContext?: Pick<MeriGovernedTurnContext, 'prompt'>;
  supplementalEvidence?: string;
}

export type WorkspaceCompiledContextPacket = CompiledContextPacket & {
  /** Runtime-only shared-plane prompt; never persisted by Workspace. */
  governedContext?: Pick<MeriGovernedTurnContext, 'prompt'>;
  /** Runtime-only bounded Retrieval V2 bodies; never persisted by Workspace. */
  supplementalEvidence?: string;
};

/**
 * Phase 21 Workspace compatibility client.
 *
 * The Workspace service no longer reads the API's governed-memory tables,
 * resolves rollout state, or writes packet persistence rows. Those
 * responsibilities belong to apps/api's shared Context Plane. The historical
 * class/method names are retained so the
 * mature generation/citation/claim-gate pipeline does not need a broad rewrite.
 */
@Injectable()
export class WorkspaceContextCompilerService {
  private readonly apiBaseUrl = (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(
    /\/+$/,
    '',
  );
  private readonly sharedSecret = process.env.INTERNAL_SERVICE_SECRET;

  async compileForClerkOwner(
    req: Omit<ContextRequest, 'userId'>,
    clerkOwnerId?: string,
  ): Promise<WorkspaceCompiledContextPacket> {
    const draftId = typeof req.ref?.draftId === 'string' ? req.ref.draftId : null;
    if (draftId) clearContextPersistenceHold(req.tenantId, draftId);
    const operationId = operationFor(req, draftId);

    try {
      const response = await this.post<CompileResponse>('compile', {
        tenantId: req.tenantId,
        clerkUserId: clerkOwnerId ?? null,
        operationId,
        request: {
          clientId: req.clientId ?? null,
          traceId: req.traceId ?? null,
          ref: req.ref ?? {},
          task:
            operationId === 'workspace.generate'
              ? 'Generate the current Workspace document using governed context.'
              : 'Assist with the current Workspace document using governed context.',
        },
      });
      if (!response.packet || typeof response.packet !== 'object') {
        throw new Error('workspace_context_plane_packet_missing');
      }
      if (
        !response.governedContext ||
        typeof response.governedContext.prompt !== 'string' ||
        typeof response.supplementalEvidence !== 'string'
      ) {
        throw new Error('workspace_context_plane_governed_projection_missing');
      }
      if (draftId && response.packet.persisted !== true) {
        markContextPersistenceHold(req.tenantId, draftId, 'context_plane_packet_not_persisted');
      }
      return Object.assign(response.packet, {
        ...(response.governedContext ? { governedContext: response.governedContext } : {}),
        ...(response.supplementalEvidence ? { supplementalEvidence: response.supplementalEvidence } : {}),
      });
    } catch (error) {
      if (draftId) {
        markContextPersistenceHold(req.tenantId, draftId, 'context_plane_compile_failed');
      }
      throw error;
    }
  }

  async resolveEthicalWallAllowedForClerkOwner(
    tenantId: string,
    clerkOwnerId: string | undefined,
    clientId: string | null,
  ): Promise<boolean> {
    if (!clientId || !clerkOwnerId) return false;
    const result = await this.post<{ allowed?: boolean }>('authorize-client', {
      tenantId,
      clerkUserId: clerkOwnerId,
      clientId,
    });
    return result.allowed === true;
  }

  async resolveClientIdByExactName(
    tenantId: string,
    clientName?: string | null,
  ): Promise<string | null> {
    const name = clientName?.trim();
    if (!name) return null;
    const result = await this.post<{ clientId?: string | null }>('resolve-client', {
      tenantId,
      clientName: name,
    });
    return typeof result.clientId === 'string' ? result.clientId : null;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    if (!this.sharedSecret) {
      throw new Error('workspace_context_plane_internal_secret_missing');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/internal/workspace/context/${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-secret': this.sharedSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`workspace_context_plane_${path}_http_${response.status}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function operationFor(
  req: Omit<ContextRequest, 'userId'>,
  draftId: string | null,
): WorkspaceOperation {
  if (req.surface === 'workspace-editor' || req.surface === 'in-editor' || !draftId) {
    return 'workspace.editor-assist';
  }
  return 'workspace.generate';
}
