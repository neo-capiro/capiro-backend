import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../../request/request-credentials.store.js';

export interface ManagedMcpToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  source: 'managed_mcp';
  appId: 'hubspot' | 'airtable';
  appName: string;
  readOnly: true;
}

@Injectable()
export class ApiManagedMcpRepo {
  private readonly logger = new Logger(ApiManagedMcpRepo.name);
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

  async schemas(): Promise<ManagedMcpToolSchema[]> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) return [];
    try {
      const response = await fetch(`${this.apiBaseUrl}/api/clio/v3/mcp-tool-schemas`, {
        headers: this.headers(creds.bearerToken, creds.impersonateTenantId, false),
      });
      if (!response.ok) {
        this.logger.warn(`Managed MCP schemas -> ${response.status}`);
        return [];
      }
      const body = (await response.json()) as { schemas?: ManagedMcpToolSchema[] };
      return Array.isArray(body.schemas) ? body.schemas : [];
    } catch (error) {
      this.logger.warn(
        `Managed MCP schemas unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  async executeRead(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error(`No forwarded credential available for managed app tool "${toolName}"`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(
        `${this.apiBaseUrl}/api/clio/v3/mcp-tools/${encodeURIComponent(toolName)}`,
        {
          method: 'POST',
          headers: {
            ...this.headers(creds.bearerToken, creds.impersonateTenantId, true),
            'content-type': 'application/json',
          },
          body: JSON.stringify(input ?? {}),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Managed app tool "${toolName}" failed: ${response.status} ${detail.slice(0, 200)}`,
        );
      }
      return response.json() as Promise<unknown>;
    } finally {
      clearTimeout(timer);
    }
  }

  private headers(
    bearerToken: string,
    impersonateTenantId: string | undefined,
    includeServiceIdentity: boolean,
  ): Record<string, string> {
    return {
      authorization: `Bearer ${bearerToken}`,
      accept: 'application/json',
      ...(includeServiceIdentity && this.serviceSecret
        ? { 'x-internal-service-secret': this.serviceSecret }
        : {}),
      ...(impersonateTenantId
        ? { 'x-capiro-impersonate-tenant': impersonateTenantId }
        : {}),
    };
  }
}
