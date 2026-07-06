import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** The resolved tenant AI credential forwarded to the orchestrator (BYOK). */
export interface ResolvedAiProviderForHeader {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

const CACHE_TTL_MS = 60_000;

/**
 * BYOK3 — resolves a tenant's AI credential from apps/api (the credential
 * store owner) so live-hearing extraction runs on the TENANT's key, not the
 * orchestrator's global fallback. Calls the InternalServiceGuard-gated
 * `POST /api/internal/ai-credentials/resolve` over a shared
 * INTERNAL_SERVICE_SECRET — never the caller's own Clerk JWT; intel-api has
 * no per-user credential-resolve capability of its own, and this endpoint is
 * deliberately NOT reachable by one (it returns a raw decrypted provider key).
 *
 * Cached per tenant for CACHE_TTL_MS (mirrors the repo's other short-TTL
 * feature-flag caches) because this sits on the PER-SEGMENT hot path (SC5.2's
 * <2s caption-latency budget) — resolving on every transcript segment would
 * add a needless network round trip per segment. Fails soft: any error, or
 * INTERNAL_SERVICE_SECRET simply not being configured, degrades to
 * `undefined` (the orchestrator's existing global-key fallback) — matching
 * every other graceful-degrade path in this service.
 */
@Injectable()
export class HearingAiCredentialResolver {
  private readonly logger = new Logger(HearingAiCredentialResolver.name);
  private readonly apiBaseUrl: string;
  private readonly sharedSecret?: string;
  private readonly cache = new Map<
    string,
    { value: ResolvedAiProviderForHeader | undefined; expiresAt: number }
  >();

  constructor(config: ConfigService) {
    this.apiBaseUrl = (config.get<string>('API_BASE_URL') ?? 'https://app.capiro.ai').replace(
      /\/+$/,
      '',
    );
    this.sharedSecret = config.get<string>('INTERNAL_SERVICE_SECRET');
  }

  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async resolve(tenantId: string): Promise<ResolvedAiProviderForHeader | undefined> {
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
      const value: ResolvedAiProviderForHeader | undefined =
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
      this.logger.warn(
        `AI credential resolve failed for tenant ${tenantId}; degrading to global key: ${(err as Error).message}`,
      );
      // Don't cache failures — a transient blip shouldn't pin the tenant to
      // the global key for the rest of the TTL window.
      return undefined;
    }
  }
}
