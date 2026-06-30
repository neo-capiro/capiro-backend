import { Injectable, Logger } from '@nestjs/common';

/**
 * Thin HTTP client to the MeriV2 orchestrator (/meri-api/*). Used ONLY by the
 * dormant flag-gated proxy branch (P0-T4) in GenerationService: when
 * meriv2.workspaceGen is ON (and MERIV2_ENABLED is set) workspace generation
 * proxies here instead of running in-process. Both flags default OFF → never
 * called. The orchestrator's workspace-generation SURFACE endpoint is built in
 * a later phase; the parity harness (SC0.3) gates enablement.
 */
@Injectable()
export class MeriV2OrchestratorClient {
  private readonly logger = new Logger(MeriV2OrchestratorClient.name);
  private readonly baseUrl = (process.env.MERIV2_ORCHESTRATOR_URL ?? '').replace(/\/+$/, '');

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  async proxyGenerateAllSections(
    tenantId: string,
    draftId: string,
    bearerToken: string | undefined,
  ): Promise<unknown> {
    if (!this.baseUrl) {
      throw new Error('MERIV2_ORCHESTRATOR_URL is not configured');
    }
    if (!bearerToken) {
      throw new Error('MeriV2 workspace-generation proxy requires the caller bearer token');
    }
    const res = await fetch(`${this.baseUrl}/meri-api/workspace-generation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tenantId, draftId }),
    });
    if (!res.ok) {
      throw new Error(`MeriV2 workspace-generation proxy failed: ${res.status} ${res.statusText}`);
    }
    return res.json();
  }
}
