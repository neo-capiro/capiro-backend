import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ResolvedAiProvider } from './meri.types.js';

const CACHE_TTL_MS = 60_000;

/**
 * D19 creds hop — resolves a tenant's AI credential from apps/api (the
 * credential-store owner) so the Meri draft/assistant loop runs on the TENANT's
 * key rather than the orchestrator's global fallback. Clones intel-api's
 * HearingAiCredentialResolver: POST the InternalServiceGuard-gated
 * `POST /api/internal/ai-credentials/resolve` over a shared INTERNAL_SERVICE_SECRET
 * (NEVER a user JWT — that endpoint returns a raw decrypted provider key).
 *
 * api-strategy MUST NOT own the decrypt path or read tenant_ai_credentials
 * directly (hard guardrail) — always hop here. Fails SOFT: any error, or the
 * secret simply not configured, degrades to `undefined` (orchestrator global-key
 * fallback), and failures are not cached.
 */
@Injectable()
export class StrategyAiCredentialResolver {
  private readonly logger = new Logger(StrategyAiCredentialResolver.name);
  private readonly apiBaseUrl: string;
  private readonly sharedSecret?: string;
  private readonly cache = new Map<string, { value: ResolvedAiProvider | undefined; expiresAt: number }>();

  constructor(config: ConfigService) {
    this.apiBaseUrl = (
      config.get<string>('API_INTERNAL_URL') ??
      config.get<string>('API_BASE_URL') ??
      'https://app.capiro.ai'
    ).replace(/\/+$/, '');
    this.sharedSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
  }

  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async resolve(tenantId: string): Promise<ResolvedAiProvider | undefined> {
    if (!this.sharedSecret) return undefined;
    const cached = this.cache.get(tenantId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/ai-credentials/resolve`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-secret': this.sharedSecret,
        },
        body: JSON.stringify({ tenantId, provider: 'anthropic' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        resolved?: boolean;
        provider?: 'anthropic' | 'openai';
        apiKey?: string;
        model?: string;
        usedTenantKey?: boolean;
        modelOverridden?: boolean;
      };
      const value: ResolvedAiProvider | undefined =
        body.resolved && body.apiKey && body.model && body.provider
          ? {
              provider: body.provider,
              apiKey: body.apiKey,
              model: body.model,
              usedTenantKey: body.usedTenantKey === true,
              modelOverridden: body.modelOverridden === true,
            }
          : undefined;
      this.cache.set(tenantId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      // Never log the header/key material; only that we degraded.
      this.logger.warn(
        `AI credential resolve failed for tenant ${tenantId}; degrading to global key: ${(err as Error).message}`,
      );
      return undefined; // don't cache failures
    }
  }
}
