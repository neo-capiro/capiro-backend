import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';

export const FOLDER_BASE = '/intel-api/legiwatch/folders';
export const IMPORT_BASE = '/intel-api/legiwatch/folder-imports';
export const folderKey = (scope: string) => ['legiwatch-folders', scope] as const;
export interface Folder {
  id: string;
  name: string;
  code: string | null;
  archived: boolean;
  clientId: string | null;
  ownerClerkId: string | null;
  otherUserAccess: string;
  defaultSession: string;
  jurisdiction: string;
  version: number;
  canEdit: boolean;
  canManage: boolean;
  count: number;
}
export interface FolderContext {
  topPriority: boolean;
  importance: string;
  position: string;
  internalComments: string;
  externalComments: string;
  version: number;
}
export interface FolderBill extends FolderContext {
  id: string;
  assignmentId: string | null;
  folderId: string | null;
  number: string;
  title: string;
  sponsor: string | null;
  status: string | null;
  jurisdiction: string;
  sessionKey: string;
  latestAction: string | null;
  latestActionAt: string | null;
  sourceUrl: string | null;
  addedAt: string | null;
  addedDateRaw: string | null;
  addedDatePrecision: string | null;
  // Additive parity fields — present only when summaryIncluded=true is requested.
  summary?: string | null;
  classifications?: string[];
  subjects?: string[];
  currentCommittee?: string | null;
}
export interface FolderPage {
  rows: FolderBill[];
  total: number;
  nextCursor: string | null;
}
export interface ActivityRow {
  id: string;
  billId: string;
  number: string;
  title: string;
  jurisdiction: string;
  sessionKey: string;
  date: string | null;
  kind: string;
  text: string | null;
  url: string | null;
  providerDocumentId: number | null;
  chamber: string | null;
  provenance: string;
}
export interface ActivityPage {
  rows: ActivityRow[];
  total: number;
  nextCursor: string | null;
  /**
   * Source availability for this jurisdiction+kind. 'unavailable' means the
   * retained activity sources do not cover it at all (e.g. federal texts or
   * amendments) — total/rows must NOT be read as a real zero-event count.
   */
  availability?: 'available' | 'unavailable';
  /** Human-readable reason when availability is 'unavailable'. */
  reason?: string | null;
  kind: string;
  from: string | null;
  to: string | null;
  /** Structured scope metadata — never rendered directly in the UI. */
  scope: {
    jurisdiction: string;
    sessionKey: string;
    folderId: string | null;
    clientId: string | null;
    onlyTracked: boolean;
    chamber: string | null;
  } | null;
}
export function useFolderTrackerFlag() {
  const api = useApi(),
    scope = useApiScope();
  const flag = useQuery({
    queryKey: [...folderKey(scope), 'flag'],
    queryFn: async () =>
      (await api.get<Record<string, boolean>>('/intel-api/feature-flags')).data
        .legiwatch_folder_tracker_v1 === true,
    staleTime: 30000,
    retry: false,
  });
  return { enabled: flag.data === true, ready: !flag.isPending, scope };
}
export function folderError(error: unknown) {
  const candidate = error as { response?: { status?: number; data?: { message?: unknown } } };
  if (candidate.response?.status === 409)
    return 'Someone changed this record. Your draft is preserved; reload the current version before saving.';
  const message = candidate.response?.data?.message;
  return typeof message === 'string'
    ? message.replaceAll('_', ' ').toLowerCase()
    : 'The request failed. Your changes have not been confirmed.';
}
export function downloadFolderCsv(csv: string) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'legiwatch-folder.csv';
  link.click();
  URL.revokeObjectURL(url);
}
