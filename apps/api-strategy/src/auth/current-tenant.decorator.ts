// Re-export seam for the shared @CurrentTenant() param decorator. Yields the
// AuthTenantContext ({ tenantId, clerkUserId, role }) attached by TenantGuard.
export { CurrentTenant } from '@capiro/auth';
