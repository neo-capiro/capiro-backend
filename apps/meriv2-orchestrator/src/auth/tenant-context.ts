/**
 * Tenant context populated by TenantGuard from a verified Clerk JWT.
 *
 * NOTE: intentionally a NARROWER shape than @capiro/shared's `TenantContext`.
 * Like apps/workspace, the orchestrator does not own the tenant / user /
 * membership tables; it trusts the verified Clerk claim for tenantId and never
 * synthesizes a Capiro userId. Tools that need a full MeriContext (e.g.
 * get_client_context's per-user visibility) resolve the Capiro userId from the
 * shared DB at the data-adapter boundary (see meri/tools); the full membership
 * cross-check (parity with apps/api TenantContextMiddleware) is the SC0.7 gate.
 */
export interface OrchestratorTenantContext {
  tenantId: string;
  clerkUserId: string;
  role: string | null;
}
