/**
 * UI-free data half of `state-bill-detail.tsx` (extraction pattern, vNext
 * Phase 2) — mirrors `bill-detail-data.ts`. `useStateBillDetail` is the ONE
 * fetch hook for a state bill's full record; the Explorer drill-in, the Radar
 * bill drawer's jurisdiction switch AND the vNext Explorer detail body all
 * share the same react-query cache entry. No antd, no CSS — importable from
 * `src/vnext/**`. `state-bill-detail.tsx` re-exports it (public API unchanged).
 */
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type { StateBillDetail } from './explorerTypes.js';

export const LINK_TYPE_LABEL: Record<string, string> = {
  same_as: 'Same as',
  companion: 'Companion',
  similar: 'Similar',
  replaces: 'Replaces',
  replaced_by: 'Replaced by',
};

/** Read-only single-state-bill detail. Same query key as the Explorer drill-in
 *  so both surfaces share one react-query cache entry per bill. */
export function useStateBillDetail(id: string | null | undefined) {
  const api = useApi();
  return useQuery<StateBillDetail | null>({
    queryKey: ['explorer-state-bill-detail', id],
    queryFn: async () =>
      (await api.get<StateBillDetail>(`/api/explorer/state-bills/${encodeURIComponent(id ?? '')}`))
        .data,
    enabled: Boolean(id),
  });
}
