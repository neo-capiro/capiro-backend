import { Logger } from '@nestjs/common';
import { AnthropicLlmClient, type LlmClient } from '@capiro/meriv2-core';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';

/**
 * BYOK2 — the orchestrator's LLM credential resolver (the ONE place a global
 * env key may be read; every LLM-backed tool binds THIS client, never a raw
 * `AnthropicLlmClient` on `process.env`).
 *
 * At completion time it resolves, in order:
 *   1. The caller-passed tenant credential (`RequestCredentialsStore.aiProvider`,
 *      BYOK option c — apps/api resolves via its AiCredentialResolverService and
 *      forwards over the already-authenticated TLS request). Model: the tenant's
 *      explicit `modelOverridden` model wins; otherwise the orchestrator's
 *      configured default (mirrors apps/api's meri.service model rule).
 *   2. The global env key (constructor-injected) — the explicit fallback the
 *      BYOK directive permits ONLY inside a resolver.
 * Neither present → throws; callers (intel-api extraction) gracefully degrade.
 *
 * The tenant key is held in-process for the single completion and is never
 * logged or persisted — observability records only `usedTenantKey`.
 */
export class RequestScopedLlmClient implements LlmClient {
  private readonly logger = new Logger(RequestScopedLlmClient.name);

  constructor(
    private readonly globalApiKey: string | undefined,
    private readonly defaultModel: string,
    private readonly timeoutMs?: number,
  ) {}

  async completeJson(params: {
    system: string;
    prompt: string;
    maxTokens?: number;
  }): Promise<Record<string, unknown>> {
    const cred = RequestCredentialsStore.get()?.aiProvider;
    const apiKey = cred?.apiKey ?? this.globalApiKey;
    if (!apiKey) {
      throw new Error(
        'No Anthropic credential available: no tenant credential on the request and no global key configured',
      );
    }
    const model = cred?.modelOverridden ? cred.model : this.defaultModel;
    const usedTenantKey = Boolean(cred?.usedTenantKey && cred.apiKey);
    this.logger.debug(`LLM completion (model=${model}, usedTenantKey=${usedTenantKey})`);
    const client = new AnthropicLlmClient({
      apiKey,
      model,
      ...(this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {}),
    });
    return client.completeJson(params);
  }
}
