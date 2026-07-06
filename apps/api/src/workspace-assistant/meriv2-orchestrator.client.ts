import { Injectable, Logger } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { WorkspaceAssistantDto } from './workspace-assistant.dto.js';

/** The resolved tenant AI credential forwarded to the orchestrator (BYOK). */
export interface ResolvedAiForHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

/**
 * Thin HTTP client to the MeriV2 orchestrator (/meri-api/*). Used ONLY by the
 * dormant flag-gated proxy branch (P0-T4): when meriv2.inEditorAssistant is ON
 * (and MERIV2_ENABLED is set) the in-editor assistant proxies here instead of
 * running its in-process loop. Both flags default OFF → never called.
 *
 * The orchestrator's in-editor-assistant SURFACE endpoint is built in a later
 * phase (Phase 0 migrated only the get_client_context tool); until then this
 * path is exercised only by the parity harness, the gate before any tenant is
 * flagged on (SC0.3). Base URL from MERIV2_ORCHESTRATOR_URL.
 */
@Injectable()
export class MeriV2OrchestratorClient {
  private readonly logger = new Logger(MeriV2OrchestratorClient.name);
  private readonly baseUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async runInEditorAssistant<T>(
    _ctx: TenantContext,
    dto: WorkspaceAssistantDto,
    bearerToken: string | undefined,
    aiProvider?: ResolvedAiForHeader,
  ): Promise<T> {
    if (!this.baseUrl) {
      throw new Error('MERIV2_ORCHESTRATOR_URL is not configured');
    }
    if (!bearerToken) {
      throw new Error('MeriV2 in-editor-assistant proxy requires the caller bearer token');
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearerToken}`,
      'content-type': 'application/json',
    };
    // BYOK option (c): pass the tenant's RESOLVED provider so the orchestrator
    // runs the in-editor loop on the tenant's key (not its global fallback). The
    // key travels only over this authenticated TLS request and is held
    // in-process for the tool call — never persisted by the orchestrator.
    if (aiProvider) {
      headers['x-capiro-ai-provider'] = JSON.stringify(aiProvider);
    }
    const res = await fetch(`${this.baseUrl}/meri-api/in-editor-assistant`, {
      method: 'POST',
      headers,
      body: JSON.stringify(dto),
    });
    if (!res.ok) {
      throw new Error(`MeriV2 in-editor-assistant proxy failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }
}
