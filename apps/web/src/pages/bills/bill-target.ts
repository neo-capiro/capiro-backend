import { useCallback } from 'react';
import { BILL_360_FEATURE, useIntelFeature } from '../../lib/intel-feature-flags.js';

/**
 * Where a bill link should GO, for a tenant that may or may not have Bill 360.
 *
 * Bill 360 (`/bills/:billId`) fails closed: a tenant without the `bill_360` flag sees
 * a "not enabled" state. So a cross-surface bill link — an old alert-email deep link,
 * a Program Element bill lane, a feed action with no drawer host — must NOT route
 * there unconditionally, or a tenant that hasn't been enabled loses the destination
 * it has today.
 *
 * This hook is the single decision point:
 *   flag ON  → `/bills/:billId` (+ `?client=` when contextual)   — R2 §2.5
 *   flag OFF → `/explorer?bill=:billId`                          — the pre-R2 target
 *
 * While the flag is unresolved it returns the legacy target: an unenabled tenant must
 * never flash a dark surface, and a redirect fires once and cannot be taken back.
 *
 * Surfaces INSIDE the dossier (BillDossierBody) don't need this — they only render
 * when the flag is already on.
 */
export function useBillTarget(): (billId: string, clientId?: string | null) => string {
  const { enabled, ready } = useIntelFeature(BILL_360_FEATURE);
  return useCallback(
    (billId: string, clientId?: string | null) => {
      const id = encodeURIComponent(billId);
      if (!ready || !enabled) return `/explorer?bill=${id}`;
      return clientId ? `/bills/${id}?client=${encodeURIComponent(clientId)}` : `/bills/${id}`;
    },
    [enabled, ready],
  );
}
