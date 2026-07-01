/**
 * Phase 1 tenant context, populated by TenantGuard from a verified Clerk JWT.
 *
 * NOTE: this is intentionally a NARROWER shape than @capiro/shared's
 * `TenantContext`. The workspace service does not (yet) own the tenant /
 * user / membership tables; it trusts the verified Clerk claim for tenantId
 * and never synthesizes a Capiro userId. The full membership cross-check
 * against the shared tenant tables is deferred to Phase 3 and will produce
 * the canonical TenantContext at that point.
 */
export interface WorkspaceTenantContext {
  tenantId: string;
  clerkUserId: string;
  role: string | null;
}
