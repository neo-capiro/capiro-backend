import { AsyncLocalStorage } from 'node:async_hooks';
import { governedMemoryTenantSelected } from '@capiro/meriv2-core';

const tenantScope = new AsyncLocalStorage<string>();

/**
 * Bind the server-resolved tenant for the complete authenticated request.
 * Browser headers/body values are not accepted here; the interceptor passes only
 * req.tenantContext populated by the verified tenant middleware.
 */
export function runWithMemoryGovernanceTenant<T>(tenantId: string, work: () => T): T {
  const normalized = String(tenantId ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) throw new Error('Memory governance requires a server-resolved tenant id.');
  return tenantScope.run(normalized, work);
}

export function currentMemoryGovernanceTenant(): string | null {
  return tenantScope.getStore() ?? null;
}

/**
 * A no-request operator/background path can be armed only by the explicit `all`
 * value. Request paths use their exact authenticated tenant.
 */
export function memoryGovernanceSelectedForCurrentTenant(
  rawTenants: string | undefined = process.env.MEMORY_GOVERNANCE_TENANTS,
): boolean {
  const tenantId = currentMemoryGovernanceTenant();
  return tenantId
    ? governedMemoryTenantSelected(tenantId, rawTenants)
    : governedMemoryTenantSelected('__background_all_only__', rawTenants) &&
        String(rawTenants ?? '')
          .split(/[,\s]+/)
          .some((value) => value.trim().toLowerCase() === 'all');
}
