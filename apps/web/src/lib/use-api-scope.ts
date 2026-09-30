import { useAuth } from '@clerk/clerk-react';
import { useImpersonation } from '../state/impersonation.js';

/** Cache identity follows the same organization/impersonation inputs as useApi. */
export function useApiScope() {
  // A few pre-auth surfaces render before ClerkProvider mounts (for example
  // a shell skeleton in an isolated browser test). Keep those renders on the
  // anonymous cache partition; authenticated renders still use the full scope.
  let orgId: string | null = null;
  let userId: string | null = null;
  try {
    const auth = useAuth();
    orgId = auth.orgId ?? null;
    userId = auth.userId ?? null;
  } catch {
    // Clerk intentionally throws outside its provider; anonymous is safe here.
  }
  const { actAsTenantSlug } = useImpersonation();
  return `${orgId ?? 'none'}:${actAsTenantSlug ?? 'self'}:${userId ?? 'anonymous'}`;
}
