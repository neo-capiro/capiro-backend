// Auth-extraction Option N (DECISIONS D8): the Clerk TenantGuard lives in
// @capiro/auth. This seam now exports MeriTenantGuard under the same name, so
// every existing `@UseGuards(TenantGuard)` import keeps working unchanged.
//
// MeriTenantGuard delegates to the shared Clerk guard for browser traffic and
// adds a narrow service-to-service path (INTERNAL_SERVICE_SECRET + explicitly
// delegated tenant/user) for intel-api's live-hearing calls, which no longer
// hold a user token. That path still enforces an ACTIVE local membership.
//
// Change-control on auth still applies; edits to the shared guard happen in
// packages/auth with Neo's approval.
export { MeriTenantGuard as TenantGuard } from './meri-tenant.guard.js';
