import { useAuth } from '@clerk/clerk-react';
import { useMemo } from 'react';
import { buildApiClient } from './api-client.js';
import { useImpersonation } from '../state/impersonation.js';

/**
 * Returns a memoized axios client. Re-created when the active org or the
 * impersonation target changes so the right token + headers are attached.
 */
export function useApi() {
  const { getToken, orgId, userId } = useAuth();
  const { actAsTenantSlug } = useImpersonation();
  return useMemo(
    () =>
      buildApiClient(
        () => getToken({ template: 'capiro' }),
        actAsTenantSlug ?? undefined,
      ),
    [getToken, orgId, userId, actAsTenantSlug],
  );
}
