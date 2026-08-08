import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';

@Injectable()
export class ApiVisualAnalysisRepo {
  private readonly logger = new Logger(ApiVisualAnalysisRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly serviceSecret?: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
  }

  /**
   * Ask apps/api—the owner of the sandbox env + tenant flag—whether the tool is
   * currently usable. Any auth/network/config failure removes run_analysis from
   * the model surface for that turn instead of advertising a doomed tool.
   */
  async available(): Promise<boolean> {
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 10_000));
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/clio/v3/capabilities`, {
        headers: {
          authorization: `Bearer ${credentials.bearerToken}`,
          accept: 'application/json',
          ...(credentials.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
            : {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { visualAnalysis?: { enabled?: unknown } };
      return body.visualAnalysis?.enabled === true;
    } catch (error) {
      this.logger.debug(
        `Visual-analysis availability check failed closed: ${
          error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)
        }`,
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async execute(input: Record<string, unknown>): Promise<unknown> {
    return this.postInternal('/api/clio/v3/visual-analysis', input, 'Visual analysis');
  }

  async discard(artifactIds: string[]): Promise<{ deleted: number }> {
    return (await this.postInternal(
      '/api/clio/v3/visual-analysis/discard',
      { artifactIds },
      'Visual analysis discard',
    )) as { deleted: number };
  }

  private async postInternal(
    path: string,
    input: Record<string, unknown>,
    operation: string,
  ): Promise<unknown> {
    const credentials = RequestCredentialsStore.get();
    if (!credentials?.bearerToken) {
      throw new Error('No forwarded credential available for MeriV3 visual analysis');
    }
    if (!this.serviceSecret) {
      throw new Error('MeriV3 internal service identity is not configured');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credentials.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          'x-internal-service-secret': this.serviceSecret,
          ...(credentials.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `${operation} failed: ${response.status} ${response.statusText} ${body.slice(0, 200)}`,
        );
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
