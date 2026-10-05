import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Immutable identity/scope established by the V3 controller only after the
 * API-issued governed context has been authenticated. This is transport
 * context, not an authorization grant; apps/api re-authorizes every read.
 */
export interface TrustedCurrentTurnScope {
  tenantId: string;
  userId: string;
  conversationId: string | null;
  selectedClientId: string | null;
}

const storage = new AsyncLocalStorage<TrustedCurrentTurnScope>();

export function currentTrustedCurrentTurnScope(): TrustedCurrentTurnScope | undefined {
  return storage.getStore();
}

export function withTrustedCurrentTurnScope<T>(scope: TrustedCurrentTurnScope, run: () => T): T {
  return storage.run(Object.freeze({ ...scope }), run);
}
