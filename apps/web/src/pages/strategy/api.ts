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
  CreateNodeInput,
  CreateStrategyInput,
  FirmPhase,
  PatchStrategyInput,
  ReferenceCalendars,
  StrategyDetail,
  StrategyListItem,
  UpdateNodeInput,
  VersionsPage,
} from './types.js';

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

/** GET /strategy-api/reference-calendars — merged Legislative + PPBE reference. */
export function useReferenceCalendars() {
  const api = useApi();
  return useQuery<ReferenceCalendars>({
    queryKey: ['strategy', 'reference-calendars'],
    queryFn: async () => (await api.get<ReferenceCalendars>(`${BASE}/reference-calendars`)).data,
    staleTime: 60_000,
  });
}
