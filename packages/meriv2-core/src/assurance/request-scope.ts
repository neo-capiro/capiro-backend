import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssuranceSurface } from './risk-gate';

export interface AssuranceRequestScope {
  tenantId: string;
  surface: AssuranceSurface;
}

const requestScope = new AsyncLocalStorage<AssuranceRequestScope>();

/**
 * Bind a server-resolved tenant and exact product surface to legacy assurance
 * helpers for one request. Browser body values are never authority: callers must
 * pass the tenant and surface already resolved by authenticated server routing.
 */
export function runWithAssuranceRequestScope<T>(
  tenantId: string,
  surface: AssuranceSurface,
  work: () => T,
): T {
  const normalized = String(tenantId ?? '').trim().toLowerCase();
  if (!normalized) throw new Error('Assurance request scope requires a tenant id.');
  return requestScope.run({ tenantId: normalized, surface }, work);
}

export function currentAssuranceRequestScope(): AssuranceRequestScope | null {
  return requestScope.getStore() ?? null;
}
