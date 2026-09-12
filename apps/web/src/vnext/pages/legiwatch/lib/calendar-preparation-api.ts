import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import type { BriefPrefill } from './wave1-api.js';
import { preparationWorkspace } from './preparation-workspace.js';
export interface CalendarFolderScope {
  folderIds?: string[];
  clientId?: string;
  jurisdiction?: string;
  session?: string;
}
export function useCalendarSourceCoverage(
  input: { from: string; to: string; session?: string },
  enabled: boolean,
) {
  const api = useApi(),
    actor = useApiScope();
  return useQuery({
    queryKey: ['lw-calendar-coverage', actor, input],
    enabled,
    retry: false,
    staleTime: 60000,
    queryFn: async () => {
      const query = new URLSearchParams({ from: input.from, to: input.to });
      if (input.session) query.set('session', input.session);
      return (
        await api.get<{
          rows: Array<{
            chamber: string;
            status: string;
            checkedAt: string;
            items: number;
            details: { expected?: number; found?: number; issues?: string[] };
          }>;
        }>(`/api/legiwatch/live-hearings/calendar/coverage?${query}`)
      ).data;
    },
  });
}
export function useCalendarFolderScope(input: CalendarFolderScope, enabled: boolean) {
  const api = useApi(),
    actor = useApiScope();
  return useQuery({
    queryKey: ['lw-calendar-scope', actor, input],
    enabled,
    retry: false,
    staleTime: 30000,
    queryFn: async () =>
      (
        await api.post<{
          folders: Array<{ id: string; name: string; clientId: string | null }>;
          billIds: string[];
          matches: Array<{ billId: string; folderId: string }>;
        }>('/intel-api/legiwatch/calendar/scope', input)
      ).data,
  });
}
export function useCreatePreparation(hearingId: string) {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: CalendarFolderScope) => {
      const prefill = (
        await api.post<BriefPrefill>(
          `/intel-api/legiwatch/calendar/events/${encodeURIComponent(hearingId)}/preparation`,
          input,
        )
      ).data;
      const draft = (await api.post<{ id: string }>('/workspace-api/drafts', prefill.draft)).data;
      const prepared = preparationWorkspace(prefill);
      await api.patch(`/workspace-api/drafts/${encodeURIComponent(draft.id)}`, {
        config: prepared.config,
      });
      await api.post(
        `/workspace-api/drafts/${encodeURIComponent(draft.id)}/context`,
        prepared.contextItem,
      );
      return { draftId: draft.id, prefill };
    },
  });
}
