import type { TenantRole } from '@capiro/shared';

/**
 * Shared-memory approval policy.
 *
 * Any active tenant administrator may act on a governed memory review,
 * including the administrator who proposed it. Assignment remains useful for
 * routing and notifications, but it is not an authorization requirement for an
 * administrator. Standard users still require the existing explicit grant and
 * current-assignment checks and may not review their own proposal.
 */
export function isMemoryReviewAdminRole(
  role: TenantRole | string | null | undefined,
): role is Extract<TenantRole, 'user_admin' | 'capiro_admin'> {
  return role === 'user_admin' || role === 'capiro_admin';
}
