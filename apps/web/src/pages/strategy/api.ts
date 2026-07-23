/*
 * Strategy Planner (PPBE) react-query client. The service is mounted at
 * /strategy-api/* on the shared ALB (own ECR/Fargate service, G1). Uses the
 * same Clerk-authed axios client as every other feature (useApi()) — the
 * Bearer capiro-JWT is attached by the shared interceptor, so nothing extra is
 * needed here. Query keys are namespaced ['strategy', …] so invalidations do
 * not prefix-collide with other features.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../lib/use-api.js';
import type {
  AssistantInput,
  AssistantResponse,
  CreateNodeInput,
  CreateStrategyInput,
  DraftStrategyInput,
  FirmPhase,
  FirmPhaseInput,
  PatchStrategyInput,
  ReferenceCalendars,
  ReferenceForkRow,
  StrategyDetail,
  StrategyListItem,
  UpdateNodeInput,
  VersionsPage,
} from './types.js';

/** Upload one file for Meri grounding → attachment id (clio pipeline, CRT-5/NOD-4/MRI-7). */
export interface AttachmentUpload {
  id: string | null;
  filename: string;
  kind: 'pdf' | 'docx' | 'image' | 'text' | 'unsupported';
  status: string;
}

const BASE = '/strategy-api';

/** GET /strategy-api/strategies — the library list. */
export function useStrategies() {
  const api = useApi();
  return useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>(`${BASE}/strategies`)).data,
    staleTime: 30_000,
  });
}

/** GET /strategy-api/strategies/:id — editor payload (meta + nodes + artifacts). */
export function useStrategy(id: string | null) {
  const api = useApi();
  return useQuery<StrategyDetail>({
    queryKey: ['strategy', 'strategy', id],
    enabled: !!id,
    queryFn: async () => (await api.get<StrategyDetail>(`${BASE}/strategies/${id}`)).data,
  });
}

/** POST /strategy-api/strategies — manual create. */
export function useCreateStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateStrategyInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies`, body)).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] }),
  });
}

/**
 * Shared success handler for a mutation returning the authoritative
 * StrategyDetail: replace the editor cache, refresh the library row
 * (lastEdited/nodeCount), and mark version history stale.
 */
function useDetailWriteHandlers(strategyId: string) {
  const qc = useQueryClient();
  return (detail: StrategyDetail) => {
    qc.setQueryData(['strategy', 'strategy', strategyId], detail);
    void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'versions', strategyId] });
  };
}

/** POST /strategies/:id/nodes — add a step (SHL-7). */
export function useAddNode(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
  return useMutation({
    mutationFn: async (input: CreateNodeInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies/${strategyId}/nodes`, input)).data,
    onSuccess: onOk,
  });
}

/** PATCH /strategies/:id/nodes/:nodeId — field edits, quick actions, drag-retime. */
export function useUpdateNode(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
  return useMutation({
    mutationFn: async (vars: { nodeId: string; input: UpdateNodeInput }) =>
      (
        await api.patch<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/nodes/${vars.nodeId}`,
          vars.input,
        )
      ).data,
    onSuccess: onOk,
  });
}

/** DELETE /strategies/:id/nodes/:nodeId — delete a step (NOD-8). */
export function useDeleteNode(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
  return useMutation({
    mutationFn: async (nodeId: string) =>
      (await api.delete<StrategyDetail>(`${BASE}/strategies/${strategyId}/nodes/${nodeId}`)).data,
    onSuccess: onOk,
  });
}

/** PATCH /strategies/:id — strategy meta edit. */
export function usePatchStrategy(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
  return useMutation({
    mutationFn: async (input: PatchStrategyInput) =>
      (await api.patch<StrategyDetail>(`${BASE}/strategies/${strategyId}`, input)).data,
    onSuccess: onOk,
  });
}

/** GET /strategies/:id/versions — paginated version history (HIS-1), cursor-based. */
export function useVersions(strategyId: string | null, enabled: boolean) {
  const api = useApi();
  return useInfiniteQuery<VersionsPage, Error, VersionsPage[], (string | null)[], string | null>({
    queryKey: ['strategy', 'versions', strategyId],
    enabled: !!strategyId && enabled,
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return (await api.get<VersionsPage>(`${BASE}/strategies/${strategyId}/versions${qs}`)).data;
    },
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages,
  });
}

/** POST /strategies/draft — Meri drafts a plan from the goal (CRT-11/12). */
export function useDraftStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: DraftStrategyInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies/draft`, body, { timeout: 90_000 })).data,
    onSuccess: (detail) => {
      qc.setQueryData(['strategy', 'strategy', detail.id], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    },
  });
}

/** POST /strategies/:id/assistant — Meri edits the plan (NOD-4 node / MRI-3 strategy). */
export function useAssistant(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssistantInput) =>
      (await api.post<AssistantResponse>(`${BASE}/strategies/${strategyId}/assistant`, input, { timeout: 90_000 }))
        .data,
    onSuccess: (resp) => {
      qc.setQueryData(['strategy', 'strategy', strategyId], resp.strategy);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'versions', strategyId] });
    },
  });
}

/** POST /reference-calendars/:kind/assist — Meri edits the working rows (REF-4, not saved). */
export function useRefAssist(kind: 'congress' | 'ppbe') {
  const api = useApi();
  return useMutation({
    mutationFn: async (input: { instruction: string; rows: unknown[] }) =>
      (
        await api.post<{ reply?: string; rows: unknown[] }>(
          `${BASE}/reference-calendars/${kind}/assist`,
          input,
          { timeout: 90_000 },
        )
      ).data,
  });
}

/** POST /api/clio/attachments — upload a doc for Meri grounding; returns its id. */
export function useUploadAttachment() {
  const api = useApi();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return (await api.post<AttachmentUpload>('/api/clio/attachments', form, { timeout: 120_000 })).data;
    },
  });
}

/** POST /strategies/:id/versions/:versionId/restore — restore (HIS-2). */
export function useRestoreVersion(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
  return useMutation({
    mutationFn: async (versionId: string) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/versions/${versionId}/restore`,
        )
      ).data,
    onSuccess: onOk,
  });
}

/** GET /strategy-api/firm-phases — tenant firm phases (empty ⇒ unconfigured). */
export function useFirmPhases() {
  const api = useApi();
  return useQuery<FirmPhase[]>({
    queryKey: ['strategy', 'firm-phases'],
    queryFn: async () => (await api.get<FirmPhase[]>(`${BASE}/firm-phases`)).data,
    staleTime: 60_000,
  });
}

/** PUT /strategy-api/firm-phases — full replace (PHS-4). */
export function usePutFirmPhases() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: FirmPhaseInput[]) =>
      (await api.put<FirmPhase[]>(`${BASE}/firm-phases`, { rows })).data,
    // The PUT returns the authoritative row set — write it straight into the
    // GET cache; no invalidate (that would refetch identical data).
    onSuccess: (data) => qc.setQueryData(['strategy', 'firm-phases'], data),
  });
}

/** GET /strategy-api/reference-calendars — merged Legislative + PPBE reference. */
export function useReferenceCalendars() {
  const api = useApi();
  return useQuery<ReferenceCalendars>({
    queryKey: ['strategy', 'reference-calendars'],
    queryFn: async () => (await api.get<ReferenceCalendars>(`${BASE}/reference-calendars`)).data,
    staleTime: 60_000,
  });
}

/** PUT /strategy-api/reference-calendars/:kind — fork-on-edit (REF-5). */
export function usePutReference(kind: 'congress' | 'ppbe') {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: ReferenceForkRow[]) =>
      (await api.put<ReferenceCalendars>(`${BASE}/reference-calendars/${kind}`, { rows })).data,
    // The PUT returns the merged calendars — write straight into the GET cache.
    onSuccess: (data) => qc.setQueryData(['strategy', 'reference-calendars'], data),
  });
}
