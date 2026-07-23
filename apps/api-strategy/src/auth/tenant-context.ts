// Re-export seam for the shared tenant-context shape, aliased for this service.
import type { AuthTenantContext } from '@capiro/auth';

export type { AuthTenantContext };
export type StrategyTenantContext = AuthTenantContext;
