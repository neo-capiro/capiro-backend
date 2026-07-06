/**
 * Tenant context populated by TenantGuard from a verified Clerk JWT.
 *
 * NOTE: intentionally a NARROWER shape than @capiro/shared's `TenantContext`.
 * The services that consume this package (apps/meriv2-orchestrator,
 * apps/workspace) do not own the tenant / user / membership tables; they trust
 * the verified Clerk claim for tenantId and never synthesize a Capiro userId.
 * Tools that need a full context (e.g. per-user visibility) resolve the Capiro
 * userId from the shared DB at the data-adapter boundary; the full membership
 * cross-check (parity with apps/api's TenantContextMiddleware) is the SC0.7
 * gate. apps/api's richer membership-backed auth deliberately does NOT use
 * this package (auth-extraction Option N, DECISIONS D8).
 */
export interface AuthTenantContext {
  tenantId: string;
  clerkUserId: string;
  role: string | null;
}
