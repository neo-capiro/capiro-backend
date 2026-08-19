/**
 * UI-free data half of `bill-detail.tsx` (extraction pattern, vNext Phase 2).
 *
 * `useBillDetail` is the ONE fetch hook for a Congress bill's full record —
 * the Explorer drill-in, the Radar BillDrawer AND the vNext Explorer detail
 * body all call it, sharing a single react-query cache entry per bill.
 * It lives here (no antd, no CSS) so `src/vnext/**` can import it without
 * pulling legacy UI; `bill-detail.tsx` re-exports it, keeping its public API
 * unchanged.
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type { BillDetail } from './explorerTypes.js';

/** Read-only single-bill detail. Same query key as the Explorer drill-in so the
 *  two surfaces share one react-query cache entry per bill. */
export function useBillDetail(billId: string | null | undefined) {
  const api = useApi();
  return useQuery<BillDetail | null>({
    queryKey: ['explorer-bill-detail', billId],
    queryFn: async () =>
      (await api.get<BillDetail>(`/api/explorer/congress-bills/${encodeURIComponent(billId ?? '')}`)).data,
    enabled: Boolean(billId),
  });
}
