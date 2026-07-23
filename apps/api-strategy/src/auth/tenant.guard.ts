// Re-export seam for the shared Clerk TenantGuard (change-controlled — do not
// reimplement). Controllers: `@UseGuards(TenantGuard)`.
export { TenantGuard } from '@capiro/auth';
