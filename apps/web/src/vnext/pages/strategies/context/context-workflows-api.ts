import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { ContextDocumentDetail, StrategyListItem } from '../../../../pages/strategy/types.js';

export function useContextAssociation(id: string, enabled: boolean) {
  const api = useApi();
  return useQuery({ queryKey: ['strategy', 'context-association', id], enabled,
    queryFn: async () => (await api.get<{ state: 'active' | 'archived' | 'missing' | 'client_mismatch' | 'not_strategy_scoped'; strategy: { id: string; title: string } | null }>(`/strategy-api/context/documents/${id}/association`)).data });
}
export function useContextReassignmentTargets(enabled: boolean) {
  const api = useApi();
  return useQuery<StrategyListItem[]>({ queryKey: ['strategy', 'strategies'], enabled, queryFn: async () => (await api.get<StrategyListItem[]>('/strategy-api/strategies')).data });
}
export function useReassignContextDocument() {
  const api = useApi(); const cache = useQueryClient();
  return useMutation({ mutationFn: async ({ id, ...body }: { id: string; expectedChecksum: string; strategyId: string }) =>
    (await api.post<ContextDocumentDetail>(`/strategy-api/context/documents/${id}/reassign`, body)).data,
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ['strategy'] }); } });
}
