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
  /**
   * Impersonation passthrough (2.5): the effective tenant an apps/api staff
   * caller is acting AS (the `x-capiro-impersonate-tenant` value). When present,
   * the delegated apps/api calls (tool executor, approval check, AND the B4.1
   * pending-action cache write) re-send this header so apps/api — which OWNS
   * impersonation authorization and re-validates it on every call — scopes the
   * write to the impersonated tenant instead of the caller's home tenant (the
   * split-tenant hazard). The pending-action cache MUST be in this set: the
   * approval row and the cached tool input are keyed by the same fingerprint but
   * live in separate RLS-isolated tables, so if they land under different tenants
   * the approved write can never be replayed. The orchestrator itself does NOT
   * authorize impersonation; it only propagates.
   */
  impersonateTenantId?: string;
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
