import { isClerkOrgAdminRole, type TenantRole } from '@capiro/shared';

/**
 * Reserved Clerk org slug for Capiro internal staff. Membership in this org can
 * grant the `capiro_admin` role (cross-tenant powers), but only when the Clerk
 * org role is admin; ordinary members remain `standard_user`.
 */
export const CAPIRO_INTERNAL_SLUG = 'capiro-internal';

/**
 * Map a Clerk organization role to a Capiro tenant role.
 *
 * Shared by the two paths that mirror Clerk org membership into Capiro:
 *   1. The Clerk webhook ingestion (`organizationMembership.*`).
 *   2. The tenant-context middleware self-heal (provisioning from a verified
 *      JWT when the local mirror is missing the row).
 * Keeping the mapping in one place guarantees both derive the SAME role from
 * the same (orgSlug, clerkRole) inputs.
 *
 * Clerk's default org roles are `org:admin` and `org:member`. Only the exact
 * keys in CLERK_ADMIN_ROLE_KEYS are treated as elevated — a custom role that
 * merely CONTAINS "admin" is deliberately NOT. The previous implementation
 * tested `normalizedRole.includes('admin')`, which silently elevated
 * `org:admin_readonly`, `org:not-admin` and `org:billing-admin` to `user_admin`,
 * and inside the capiro-internal org to cross-tenant `capiro_admin`.
 *
 * NOTE this is a DOWNGRADE path, not a denial path: an unrecognized role maps
 * to `standard_user` rather than throwing, because the self-heal call site
 * (tenant-context.middleware.ts) provisions a membership from a verified JWT
 * and must not lock the user out. Verified 2026-07-25 that the live Clerk
 * instance defines only `org:admin` and `org:member`, so no existing member is
 * downgraded by this change.
 */
export function mapClerkRoleToCapiro(orgSlug: string, clerkRole: string): TenantRole {
  const isAdmin = isClerkOrgAdminRole(clerkRole);
  if (orgSlug === CAPIRO_INTERNAL_SLUG) {
    return isAdmin ? 'capiro_admin' : 'standard_user';
  }
  return isAdmin ? 'user_admin' : 'standard_user';
}
