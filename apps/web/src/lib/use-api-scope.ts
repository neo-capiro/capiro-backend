import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../state/impersonation.js';

/** Cache identity follows the same organization/impersonation inputs as useApi. */
export function useApiScope() {
  const { orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return `${orgId ?? 'none'}:${actAsTenantSlug ?? 'self'}:${userId ?? 'anonymous'}`;
}
