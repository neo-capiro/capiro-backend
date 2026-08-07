/**
 * Precondition helper for the orgless Phase 1 browser proof.
 *
 * The orgless acceptance path carries no tenant id, org id, tenant slug, or X-Capiro-Tenant
 * hint, so TenantContextMiddleware resolves the tenant through its sole-membership fallback.
 * That fallback fires only when the user has exactly one active membership, which makes the
 * membership count a hard precondition of the proof rather than incidental fixture detail.
 *
 * Kept here, rather than inline in the acceptance script, so it is typechecked and unit
 * tested: `apps/api/scripts/` is excluded from every tsconfig.
 */

export interface ActiveMembershipRow {
  tenantId: string;
  slug: string;
  clerkOrgId: string | null;
  role: string;
}

export interface SoleMembershipResult {
  activeMemberships: number;
  tenantSlug: string;
  role: string;
  /** Reported for evidence only. The fallback never requires it. */
  tenantClerkOrgIdPresent: boolean;
  clerkOrgIdRequired: false;
}

export function assertSoleActiveMembership(
  rows: readonly ActiveMembershipRow[],
): SoleMembershipResult {
  if (rows.length === 0) {
    throw new Error(
      'Orgless Phase 1 acceptance requires exactly one active tenant membership for the ' +
        'fixture user; found 0. With no active membership the authenticated request cannot ' +
        'resolve a tenant at all.',
    );
  }
  if (rows.length > 1) {
    throw new Error(
      'Orgless Phase 1 acceptance requires exactly one active tenant membership for the ' +
        `fixture user; found ${rows.length} (${rows.map((row) => row.slug).join(', ')}). ` +
        'With more than one active membership the sole-membership fallback does not fire, so ' +
        'the proof would depend on an ambiguous tenant selection.',
    );
  }

  const membership = rows[0]!;
  return {
    activeMemberships: 1,
    tenantSlug: membership.slug,
    role: membership.role,
    tenantClerkOrgIdPresent: Boolean(membership.clerkOrgId),
    clerkOrgIdRequired: false,
  };
}
