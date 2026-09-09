import type { QueryClient } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import { getClientDistrictNexus } from '../../../pages/clients/intelligence-v1/district-nexus-api.js';
import { getClientFecMoneyFlow } from '../../../pages/clients/intelligence-v1/fec-money-flow-api.js';
import { getClientLdaFilings } from '../../../pages/clients/intelligence-v1/lda-filings-api.js';

/** Re-read the imported footprint and update the exact caches its cards use. */
export async function refreshClientFootprint(qc: QueryClient, api: AxiosInstance, clientId: string) {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['client-district-nexus-v2', clientId] }),
    qc.invalidateQueries({ queryKey: ['pf-district-nexus-v2', clientId] }),
    qc.invalidateQueries({
      predicate: (query) => query.queryKey[0] === 'federal-market' && query.queryKey[8] === clientId,
    }),
  ]);
  const results = await Promise.allSettled([
    qc.fetchQuery({ queryKey: ['client-district-nexus', clientId], queryFn: () => getClientDistrictNexus(api, clientId), staleTime: 0, retry: false }),
    qc.fetchQuery({ queryKey: ['client-fec-money-flow', clientId], queryFn: () => getClientFecMoneyFlow(api, clientId), staleTime: 0, retry: false }),
    qc.fetchQuery({ queryKey: ['client-lda-filings', clientId], queryFn: () => getClientLdaFilings(api, clientId), staleTime: 0, retry: false }),
  ]);
  return { total: results.length, failures: results.filter((result) => result.status === 'rejected').length };
}
