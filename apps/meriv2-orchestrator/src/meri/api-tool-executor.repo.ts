import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext, ToolExecutor } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/**
 * `ToolExecutor` that delegates a named tool to apps/api's existing
 * authenticated executor: `POST /api/clio/tools/:name`, backed by
 * MeriToolsService.executeFromAuthenticatedUser (the ONE tenant-scoped
 * implementation + BYOK path). Forwards the caller's verified Bearer token, so
 * apps/api re-derives the full TenantContext and applies its own field
 * validation + scoping — no SQL duplicated, no behavior drift. Same bridge
 * pattern as ApiClientContextRepo, generalized to any tool.
 *
 * This runs INSIDE a real user request (the registry invoke path), so the
 * forwarded user Bearer is always present; non-user callers (hearing backfill)
 * are out of scope here and require the separate service-auth path.
 */
@Injectable()
export class ApiToolExecutorRepo implements ToolExecutor {
  private readonly logger = new Logger(ApiToolExecutorRepo.name);
  private readonly apiBaseUrl: string;
  private readonly timeoutMs: number;
  // Shared backend secret (same one apps/api's /internal/* routes use). Sent as
  // x-internal-service-secret so apps/api's ToolServiceSecretGuard can prove THIS
  // tool call came from the orchestrator (post compliance-gate), not a rogue user
  // bearer hitting /api/clio/tools/:name directly. Inert until wired on the
  // orchestrator task def; harmless to send when apps/api isn't yet enforcing.
  private readonly serviceSecret?: string;

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
    ).replace(/\/+$/, '');
    this.timeoutMs = Number.parseInt(config.get<string>('MERIV2_TOOL_TIMEOUT_MS') ?? '60000', 10);
    this.serviceSecret = config.get<string>('INTERNAL_SERVICE_SECRET') || undefined;
  }

  async execute(
    _ctx: MeriContext,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const creds = RequestCredentialsStore.get();
    if (!creds?.bearerToken) {
      throw new Error(`No forwarded credential available for delegated tool "${toolName}"`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const url = `${this.apiBaseUrl}/api/clio/tools/${encodeURIComponent(toolName)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${creds.bearerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
          // Service identity: proves this call came from the orchestrator (after
          // its compliance gate), so apps/api can reject a rogue user hitting the
          // raw tool endpoint directly. See ToolServiceSecretGuard.
          ...(this.serviceSecret ? { 'x-internal-service-secret': this.serviceSecret } : {}),
          // Impersonation passthrough (2.5): re-send the effective-tenant header
          // so apps/api scopes THIS delegated tool call to the impersonated
          // tenant (it re-validates the caller's impersonation rights).
          ...(creds.impersonateTenantId
            ? { 'x-capiro-impersonate-tenant': creds.impersonateTenantId }
            : {}),
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`Delegated tool "${toolName}" -> ${res.status}`);
        throw new Error(
          `Delegated tool "${toolName}" failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
        );
      }
      return (await res.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }
}
