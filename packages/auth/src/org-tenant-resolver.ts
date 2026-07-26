/**
 * Canonical organization -> tenant resolution, and active-membership lookup.
 *
 * packages/auth has NO database dependency (its package.json declares only
 * @clerk/backend, @nestjs/common and @nestjs/config), and it must stay that way
 * — the four consuming services own different Prisma schemas and different
 * generated clients. So the contract lives here and each service supplies the
 * implementation for its own connection.
 *
 * IMPORTANT: the DI token is a STRING, never a Symbol. packages/auth compiles
 * to CommonJS while every consumer app is ESM with .js import suffixes; a
 * `Symbol()` would be identity-unique per loaded module copy and silently
 * resolve to undefined inside the built Docker images — the one environment
 * that is hardest to reproduce locally.
 */

export const ORG_TENANT_RESOLVER = 'CAPIRO_ORG_TENANT_RESOLVER';

export interface ResolvedTenant {
  /** tenants.id — always a UUID string. */
  tenantId: string;
  /** tenants.slug — citext in Postgres, so compare case-insensitively. */
  slug: string;
  /** tenants.clerk_org_id — NULLABLE. A tenant that has never been linked to a
   *  Clerk organization has null here, which is why the org cross-check in the
   *  guard is conditional on this being present. */
  clerkOrgId: string | null;
}

export interface OrgTenantResolver {
  /** Resolve by the Clerk organization id (`org_...`) carried in `org_id`. */
  resolveByClerkOrgId(clerkOrgId: string): Promise<ResolvedTenant | null>;

  /** Resolve by tenant UUID, as carried in the `capiro_tenant_id` template
   *  claim. Used as the fallback when a tenant row has no clerk_org_id yet. */
  resolveByTenantId(tenantId: string): Promise<ResolvedTenant | null>;

  /**
   * True when this Clerk identity holds an ACTIVE local membership of this
   * tenant.
   *
   * This is the control the audit's finding #2 is really about: Clerk org
   * membership and Capiro's `tenant_memberships` table can diverge — a user
   * removed in Capiro keeps issuing valid org-bearing tokens until the Clerk
   * mirror catches up, and if the Clerk delete failed it never does. apps/api
   * has always checked this (`where: { userId, status: 'active' }`); the other
   * services never did.
   *
   * Implementations MUST treat any non-'active' status (invited, suspended,
   * removed) as false, and MUST fail closed on error.
   */
  hasActiveMembership(tenantId: string, clerkUserId: string): Promise<boolean>;
}
