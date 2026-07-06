import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';

/**
 * Thin client the orchestrator uses to route workspace generation back to
 * apps/workspace's NON-PROXY entry (`/workspace-api/drafts/:id/generate-all-direct`),
 * forwarding the caller's verified bearer. That entry runs
 * generateAllSectionsInProcess — so the compliance-sensitive reasoning +
 * anonymization stay in apps/workspace (its data, its doctrine) and there is no
 * orchestrator→workspace→orchestrator recursion (the direct entry never
 * re-checks the meriv2.workspaceGen proxy flag).
 *
 * Base URL from MERIV2_WORKSPACE_BASE_URL (defaults to the shared host; the
 * `/workspace-api` prefix is fixed).
 */
@Injectable()
export class WorkspaceGenClient {
  private readonly logger = new Logger(WorkspaceGenClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (
      config.get<string>('MERIV2_WORKSPACE_BASE_URL') ??
      config.get<string>('MERIV2_API_BASE_URL') ??
      'http://localhost:3100'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
  }

  async generateAllSections(draftId: string): Promise<unknown> {
    const bearer = RequestCredentialsStore.get()?.bearerToken;
    if (!bearer) {
      throw new Error('workspace-generation requires the caller bearer token');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.baseUrl}/workspace-api/drafts/${encodeURIComponent(draftId)}/generate-all-direct`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: '{}',
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`workspace generate-all-direct -> ${res.status}`);
        throw new Error(
          `workspace-generation failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
