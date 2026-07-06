// @capiro/auth — the shared "Clerk-verify → narrow tenant context" module for
// apps/meriv2-orchestrator and apps/workspace (auth-extraction Option N,
// DECISIONS D8). apps/api's membership-backed auth deliberately stays its own.
export { AuthModule } from './auth.module';
export { ClerkService, normalizeClaims, type ClerkSessionClaims } from './clerk.service';
export { TenantGuard } from './tenant.guard';
export { CurrentTenant } from './current-tenant.decorator';
export type { AuthTenantContext } from './tenant-context';
