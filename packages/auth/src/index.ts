// @capiro/auth — the shared "Clerk-verify → canonical tenant context" module.
//
// Consumers (verified via `"@capiro/auth"` in each package.json):
//   apps/workspace, apps/api-strategy, apps/meriv2-orchestrator, apps/onboard-api
// apps/api keeps its own membership-backed auth. apps/intel-api is NOT a
// consumer — it carries an independent FORK under src/auth, so any change here
// must be mirrored there by hand.
export { AuthModule } from './auth.module';
export { ClerkService, normalizeClaims, type ClerkSessionClaims } from './clerk.service';
export { TenantGuard } from './tenant.guard';
export { CurrentTenant } from './current-tenant.decorator';
export type { AuthTenantContext } from './tenant-context';
export { ORG_TENANT_RESOLVER } from './org-tenant-resolver';
export type { OrgTenantResolver, ResolvedTenant } from './org-tenant-resolver';
