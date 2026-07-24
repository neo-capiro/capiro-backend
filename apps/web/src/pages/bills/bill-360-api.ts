import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type { BillDossierResponse } from './bill-360.types.js';

/**
 * Fetch the Bill 360 dossier (R1 contract). Global vs client use SEPARATE React
 * Query keys so client context never leaks between bill pages (plan §2.6):
 *   global  → GET /intel-api/bills/:billId/dossier
 *   client  → GET /intel-api/clients/:clientId/bills/:billId/dossier
 */
export function useBillDossier(billId: string | null | undefined, clientId?: string | null) {
  const api = useApi();
  return useQuery<BillDossierResponse | null>({
    queryKey: ['bill-dossier', billId ?? null, clientId ?? null],
    queryFn: async () => {
      const id = encodeURIComponent(billId ?? '');
      const path = clientId
        ? `/intel-api/clients/${encodeURIComponent(clientId)}/bills/${id}/dossier`
        : `/intel-api/bills/${id}/dossier`;
      return (await api.get<BillDossierResponse>(path)).data;
    },
    enabled: Boolean(billId),
  });
}
