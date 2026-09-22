import { useMutation, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { FOLDER_BASE, type Folder } from '../legiwatch/bills/folder-api.js';
import { EVIDENCE_BASE } from '../legiwatch/editorial/evidence-api.js';

export const LEGIWATCH_FOLDERS_KEY = ['legiwatch-folders'] as const;

export const articleObservationPath = (articleId: string) =>
  `/api/explorer/intel-articles/${encodeURIComponent(articleId)}/legiwatch-observation`;

export function useLegiWatchFolders(enabled: boolean) {
  const api = useApi();
  return useQuery({
    queryKey: LEGIWATCH_FOLDERS_KEY,
    queryFn: async () => (await api.get<Folder[]>(FOLDER_BASE)).data.filter((f) => !f.archived),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export interface SaveArticleInput {
  articleId: string;
  folder: Folder;
}

/** The track endpoint wants a LegiWatch news OBSERVATION id, not the article
 *  id, so the article is first resolved to (or given) its observation. */
export function useSaveArticleToFolder() {
  const api = useApi();
  return useMutation({
    mutationFn: async ({ articleId, folder }: SaveArticleInput) => {
      const { observationId } = (
        await api.post<{ observationId: string }>(articleObservationPath(articleId))
      ).data;
      try {
        await api.post(`${EVIDENCE_BASE}/track`, {
          clientId: folder.clientId ?? null,
          folderId: folder.id,
          kind: 'news',
          sourceId: observationId,
          expectedVersion: 0,
          removed: false,
        });
      } catch (err) {
        // This save always targets a brand-new tracking row (version 0). A 409
        // here means one already exists — already saved to this folder in an
        // earlier session or from LegiWatch's own Evidence tab — which is the
        // outcome this action wants, not a real conflict to surface as an
        // unrecoverable error (there is no version to reconcile against here).
        const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
        if (status !== 409) throw err;
      }
      return folder;
    },
  });
}
