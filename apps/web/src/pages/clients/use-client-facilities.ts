import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import { getClientFacilities } from './facilities-api.js';

/** Resolution continues after the editor closes. Refresh every derived view
 * when the persisted result arrives, rather than only when the save returns. */
export function useClientFacilities(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['client-facilities', clientId],
    queryFn: () => getClientFacilities(api, clientId),
    staleTime: 60_000,
    refetchInterval: (q) =>
      q.state.data?.some((f) => f.geocodeStatus === 'pending') ? 2000 : false,
  });
  const signature =
    query.data == null
      ? null
      : JSON.stringify(
          query.data.map((f) => [
            f.id,
            f.updatedAt,
            f.geocodeStatus,
            f.latitude,
            f.longitude,
            f.congressionalDistrict,
            f.stateHouseDistrict,
            f.stateSenateDistrict,
          ]),
        );
  const previous = useRef<{ clientId: string; signature: string } | null>(null);
  useEffect(() => {
    if (signature == null) return;
    const before = previous.current;
    previous.current = { clientId, signature };
    if (!before || before.clientId !== clientId || before.signature === signature) return;
    for (const key of [
      'client-representation',
      'client-district-nexus',
      'client-district-nexus-v2',
      'pf-district-nexus-v2',
    ]) {
      void qc.invalidateQueries({ queryKey: [key, clientId] });
    }
    void qc.invalidateQueries({ queryKey: ['district-nexus', 'map'] });
    void qc.invalidateQueries({ queryKey: ['district-nexus', 'gaps'] });
  }, [clientId, signature, qc]);
  return query;
}
