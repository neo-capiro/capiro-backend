import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request carrier for the verified caller's raw Bearer token, used to
 * forward credentials to delegated apps/api calls (the Phase-0 strangler
 * bridge). Kept OUT of `MeriContext` so the scoping identity stays pure; this
 * is transport, not identity. Mirrors the AsyncLocalStorage pattern apps/api
 * uses for its TenantContextStore.
 */
export interface RequestCredentials {
  bearerToken: string;
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
