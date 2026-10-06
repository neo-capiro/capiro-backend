import { GatewayTimeoutException, Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { WorkspaceContextPlaneService } from './workspace-context-plane.service.js';
import type { WorkspaceAssistantDto } from './workspace-assistant.dto.js';

export const EDITOR_PROXY_BUDGET_MS = 160_000;
const EDITOR_CONTEXT_BUDGET_MS = 25_000;

function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new GatewayTimeoutException('The edit could not finish in time. No changes were applied. Please try a smaller edit.'));
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The resolved tenant AI credential forwarded to the orchestrator (BYOK). */
export interface ResolvedAiForHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

/**
 * Thin HTTP client to the MeriV2 orchestrator (/meri-api/*).
 *
 * Phase 21 resolves Workspace editor context through apps/api's shared Context
 * Plane before crossing the service boundary. The backend-only service secret
 * authenticates that hop so a browser cannot forge a governed context bundle.
 */
@Injectable()
export class MeriV2OrchestratorClient {
  private readonly logger = new Logger(MeriV2OrchestratorClient.name);
  private readonly baseUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');
  private readonly internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? '';

  constructor(private readonly contextPlane: WorkspaceContextPlaneService) {}

  get configured(): boolean {
    return this.baseUrl.length > 0 && this.internalSecret.length > 0;
  }

  async runInEditorAssistant<T>(
    ctx: TenantContext,
    dto: WorkspaceAssistantDto,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiForHeader,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('MERIV2_ORCHESTRATOR_URL is not configured');
    }
    if (!this.internalSecret) {
      throw new Error('MeriV2 in-editor-assistant proxy requires INTERNAL_SERVICE_SECRET');
    }
    if (!bearerToken) {
      throw new Error('MeriV2 in-editor-assistant proxy requires the caller bearer token');
    }
    const tenantId = ctx.tenantId?.trim();
    const clerkUserId = ctx.clerkUserId?.trim();
    if (!tenantId || !clerkUserId) {
      throw new Error('MeriV2 in-editor-assistant proxy requires authenticated tenant and Clerk user identities');
    }

    const deadline = AbortSignal.timeout(EDITOR_PROXY_BUDGET_MS);
    const governed = await beforeDeadline(this.contextPlane.resolveEditor(ctx, dto),
      AbortSignal.any([deadline, AbortSignal.timeout(EDITOR_CONTEXT_BUDGET_MS)]));
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
      'x-internal-service-secret': this.internalSecret,
      // The orchestrator's existing service guard requires explicit delegation
      // and rechecks active membership using the Clerk ID, not our local UUID.
      // These identities come only from authenticated server context.
      'x-capiro-delegated-tenant': tenantId,
      'x-capiro-delegated-user': clerkUserId,
    };
    if (aiProvider) headers['x-capiro-ai-provider'] = JSON.stringify(aiProvider);

    const res = await beforeDeadline(fetch(`${this.baseUrl}/meri-api/in-editor-assistant`, {
      method: 'POST',
      headers,
      signal: deadline,
      body: JSON.stringify({
        ...dto,
        governedContext: governed.governedContext,
      }),
    }), deadline);
    if (!res.ok) {
      this.logger.warn(`MeriV2 in-editor-assistant proxy failed with status ${res.status}`);
      throw new Error(`MeriV2 in-editor-assistant proxy failed: ${res.status} ${res.statusText}`);
    }
    return await beforeDeadline(res.json() as Promise<T>, deadline);
  }
}
