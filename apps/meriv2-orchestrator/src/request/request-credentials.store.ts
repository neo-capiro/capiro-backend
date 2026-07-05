import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request carrier for the verified caller's raw Bearer token, used to
 * forward credentials to delegated apps/api calls (the Phase-0 strangler
 * bridge). Kept OUT of `MeriContext` so the scoping identity stays pure; this
 * is transport, not identity. Mirrors the AsyncLocalStorage pattern apps/api
 * uses for its TenantContextStore.
 *
 * BYOK (option c): the caller that owns the credential store (apps/api's
 * AiCredentialResolverService) RESOLVES the tenant's AI credential and passes
 * it on the request; the orchestrator holds it in-process for the duration of
 * the tool call only — never persisted, never logged. `RequestScopedLlmClient`
 * reads it at completion time and falls back to the global env key when absent.
 */
export interface ResolvedAiProvider {
  provider: 'anthropic' | 'openai';
  apiKey: string;
  model: string;
  usedTenantKey: boolean;
  modelOverridden: boolean;
}

export interface RequestCredentials {
  bearerToken: string;
  /** Caller-resolved tenant AI credential (BYOK option c). Optional. */
  aiProvider?: ResolvedAiProvider;
}

const als = new AsyncLocalStorage<RequestCredentials>();

export const RequestCredentialsStore = {
  run<T>(creds: RequestCredentials, fn: () => Promise<T>): Promise<T> {
    return als.run(creds, fn);
  },
  get(): RequestCredentials | undefined {
    return als.getStore();
  },
};
