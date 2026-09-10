/*
 * Strategies vNext — data layer.
 *
 * New, module-owned react-query hooks over the SAME backend the canonical app
 * uses (`/strategy-api/*`, Clerk-authed shared axios `useApi()`). Query keys stay
 * in the `['strategy', …]` namespace so a mutation on either front-end invalidates
 * the same records on the other (STRATEGIES-HANDOFF §3.3 — cross-app invalidation).
 *
 * This file OWNS no domain types: it imports the server contract from
 * `pages/strategy/types.ts` (the DTO mirror) and reuses the tolerant normalizers in
 * `pages/strategy/agents/agent-utils.ts` / `context/context-utils.ts`, exactly like
 * the canonical client. Types and response normalizers are shared server-contract
 * surface — not UI. Every component in this module is new; no old strategy
 * component is imported anywhere.
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
/* NOTE (overlay build, 2026-08): this import previously read
 * '../../../../../lib/use-api.js' (5 levels up → apps/lib/, which does not
 * exist — verified with ls). use-api lives at apps/web/src/lib/use-api.ts,
 * 3 levels up from this file. Fixed so the overlay set can import these hooks. */
import { useApi } from '../../../lib/use-api.js';
import type {
  AcceptAllWatchInput,
  AgentMission,
  AgentRun,
  ApproveChangeSetInput,
  AssistantInput,
  AssistantResponse,
  ChangeSet,
  ChangeSetStatus,
  ContextConflict,
  ContextDocumentDetail,
  ContextDocumentListItem,
  ContextFact,
  ContextHealth,
  ContextLocateResult,
  ContextSection,
  CreateMissionInput,
  CreateNodeInput,
  CreateStrategyInput,
  DraftStrategyInput,
  ExecutionRun,
  ExecutionPreflight,
  WatchMonitoring,
  RunPolicy,
  ReconcileResult,
  ExtractFactsResult,
  FirmPhase,
  FirmPhaseInput,
  PlanExecutionInput,
  ReferenceCalendars,
  RecordArtifactInput,
  ResolveConflictInput,
  RestoreImpact,
  ResumeRunInput,
  RunCheckResult,
  StrategyDetail,
  StrategyListItem,
  StrategyChatMessage,
  StrategyVersion,
  UpdateMissionInput,
  UpdateNodeInput,
  UploadContextDocumentInput,
  VersionsPage,
  WatchAcceptResult,
  WatchReviewState,
} from '../../../pages/strategy/types.js';
import {
  normalizeChangeSets,
  normalizeExecutionRuns,
  normalizeMission,
  normalizeMissions,
  normalizeRun,
  normalizeRunCheck,
  normalizeRuns,
} from '../../../pages/strategy/agents/agent-utils.js';
import {
  normalizeConflicts,
  normalizeContextHealth,
  normalizeDocument,
  normalizeDocumentList,
  normalizeExtractResult,
  normalizeFacts,
  normalizeLocate,
  normalizeSections,
} from '../../../pages/strategy/context/context-utils.js';
import { strategyDetailRetry } from './lib/strategy-load.js';

const BASE = '/strategy-api';

/* ---------------------------------------------------------------- strategies */

export function useStrategies() {
  const api = useApi();
  return useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () =>
      (await api.get<StrategyListItem[]>(`${BASE}/strategies`)).data,
    staleTime: 30_000,
  });
}

export function useStrategy(id: string | null) {
  const api = useApi();
  return useQuery<StrategyDetail>({
    queryKey: ['strategy', 'strategy', id],
    enabled: !!id,
    queryFn: async () =>
      (await api.get<StrategyDetail>(`${BASE}/strategies/${id}`)).data,
    // F08: a deleted (410), unknown (404), forbidden (403) or unauthenticated
    // (401) detail load is terminal — react-query must not re-fire the doomed
    // GET on window refocus/mount cycles. Transient failures keep the app's
    // bounded default (`retry: 1`, main.tsx) via the same predicate.
    retry: strategyDetailRetry,
  });
}

export function useVersions(strategyId: string | null, enabled = true) {
  const api = useApi();
  return useQuery<StrategyVersion[]>({
    queryKey: ['strategy', 'versions', strategyId],
    enabled: !!strategyId && enabled,
    queryFn: async () =>
      (await api.get<VersionsPage>(`${BASE}/strategies/${strategyId}/versions`))
        .data.items,
  });
}

export function useRestoreImpact(
  strategyId: string | null,
  versionId: string | null,
) {
  const api = useApi();
  return useQuery<RestoreImpact>({
    queryKey: ['strategy', 'restore-impact', strategyId, versionId],
    enabled: !!strategyId && !!versionId,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      (
        await api.get<RestoreImpact>(
          `${BASE}/strategies/${strategyId}/versions/${versionId}/restore-impact`,
        )
      ).data,
  });
}

/* ------------------------------------------------------- reference layers */

export function useFirmPhases() {
  const api = useApi();
  return useQuery<FirmPhase[]>({
    queryKey: ['strategy', 'firm-phases'],
    queryFn: async () =>
      (await api.get<FirmPhase[]>(`${BASE}/firm-phases`)).data,
    staleTime: 60_000,
  });
}

export function useReferenceCalendars() {
  const api = useApi();
  return useQuery<ReferenceCalendars>({
    queryKey: ['strategy', 'reference-calendars'],
    queryFn: async () =>
      (await api.get<ReferenceCalendars>(`${BASE}/reference-calendars`)).data,
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------ context (D) */

export function useContextDocuments(clientId?: string, firmOnly = false) {
  const api = useApi();
  return useQuery<ContextDocumentListItem[]>({
    queryKey: firmOnly ? ['strategy', 'context-documents', 'firm'] : clientId ? ['strategy', 'context-documents', clientId] : ['strategy', 'context-documents'],
    queryFn: async () =>
      normalizeDocumentList(
        (await api.get<unknown>(`${BASE}/context/documents?includeStale=true${firmOnly ? '&firmOnly=true' : clientId ? `&clientId=${encodeURIComponent(clientId)}&includeFirm=true` : ''}`))
          .data,
      ),
    staleTime: 30_000,
  });
}

export function useContextDocument(id: string | null) {
  const api = useApi();
  return useQuery<ContextDocumentDetail>({
    queryKey: ['strategy', 'context-document', id],
    enabled: !!id,
    queryFn: async () =>
      normalizeDocument(
        (await api.get<unknown>(`${BASE}/context/documents/${id}`)).data,
      ),
  });
}

export function useContextSections(id: string | null) {
  const api = useApi();
  return useQuery<ContextSection[]>({
    queryKey: ['strategy', 'context-sections', id],
    enabled: !!id,
    queryFn: async () =>
      normalizeSections(
        (await api.get<unknown>(`${BASE}/context/documents/${id}/sections`))
          .data,
      ),
    staleTime: 30_000,
  });
}

/**
 * GET /context/documents/:id/locate?ref=… — exact 1-based source lines for a
 * fact's `sourceRef` (no LLM). The Resolve-conflict overlay (§7.10f) uses this
 * to render the "exact line evidence" the decision record cites.
 */
export function useContextLocate(
  documentId: string | null,
  ref: string | null,
) {
  const api = useApi();
  return useQuery<ContextLocateResult>({
    queryKey: ['strategy', 'context-locate', documentId, ref],
    enabled: !!documentId && !!ref,
    staleTime: 60_000,
    queryFn: async () =>
      normalizeLocate(
        (
          await api.get<unknown>(
            `${BASE}/context/documents/${documentId}/locate?ref=${encodeURIComponent(ref ?? '')}`,
          )
        ).data,
        ref ?? '',
      ),
  });
}

/* ------------------------------------------------------------- steward (E) */

export function useContextFacts(
  filter: { documentId?: string; clientId?: string; state?: ContextFact['state']; includeFirm?: boolean; firmOnly?: boolean } = {},
  enabled = true,
) {
  const api = useApi();
  const query = new URLSearchParams();
  if (filter.documentId) query.set('documentId', filter.documentId);
  if (filter.clientId) query.set('clientId', filter.clientId);
  if (filter.includeFirm) query.set('includeFirm', 'true');
  if (filter.firmOnly) query.set('firmOnly', 'true');
  if (filter.state) query.set('state', filter.state);
  const suffix = query.size ? `?${query.toString()}` : '';
  return useQuery<ContextFact[]>({
    queryKey: suffix ? ['strategy', 'context-facts', filter] : ['strategy', 'context-facts'],
    enabled,
    queryFn: async () =>
      normalizeFacts((await api.get<unknown>(`${BASE}/context/facts${suffix}`)).data),
    staleTime: 30_000,
  });
}

export function useContextFact(id: string | null) {
  const api = useApi();
  return useQuery<ContextFact | undefined>({ queryKey: ['strategy', 'context-fact', id], enabled: !!id,
    queryFn: async () => normalizeFacts([(await api.get<unknown>(`${BASE}/context/facts/${encodeURIComponent(id ?? '')}`)).data])[0] });
}

export function useContextConflicts(clientId?: string, firmOnly = false) {
  const api = useApi();
  return useQuery<ContextConflict[]>({
    queryKey: firmOnly ? ['strategy', 'context-conflicts', 'firm'] : clientId ? ['strategy', 'context-conflicts', clientId] : ['strategy', 'context-conflicts'],
    queryFn: async () =>
      normalizeConflicts(
        (await api.get<unknown>(`${BASE}/context/conflicts${firmOnly ? '?firmOnly=true' : clientId ? `?clientId=${encodeURIComponent(clientId)}&includeFirm=true` : ''}`)).data,
      ),
    staleTime: 30_000,
  });
}

export function useContextHealth(clientId: string | null) {
  const api = useApi();
  return useQuery<ContextHealth>({
    queryKey: ['strategy', 'context-health', clientId],
    enabled: !!clientId,
    queryFn: async () =>
      normalizeContextHealth(
        (
          await api.get<unknown>(
            `${BASE}/context/health?clientId=${encodeURIComponent(clientId ?? '')}`,
          )
        ).data,
      ),
    staleTime: 30_000,
  });
}

/* -------------------------------------------------------------- agents (F) */

export function useChangeSets(
  filter: { status?: ChangeSetStatus; strategyId?: string } = {},
  enabled = true,
) {
  const api = useApi();
  const qs = new URLSearchParams();
  if (filter.status) qs.set('status', filter.status);
  if (filter.strategyId) qs.set('strategyId', filter.strategyId);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return useQuery<ChangeSet[]>({
    queryKey: [
      'strategy',
      'change-sets',
      filter.status ?? 'all',
      filter.strategyId ?? 'all',
    ],
    enabled,
    queryFn: async () =>
      normalizeChangeSets(
        (await api.get<unknown>(`${BASE}/agents/change-sets${suffix}`)).data,
      ),
    staleTime: 15_000,
  });
}

export function useMissions(strategyId?: string | null, enabled = true) {
  const api = useApi();
  const suffix = strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : '';
  return useQuery<AgentMission[]>({
    queryKey: ['strategy', 'missions', strategyId ?? 'all'],
    enabled,
    queryFn: async () =>
      normalizeMissions((await api.get<unknown>(`${BASE}/agents/missions${suffix}`)).data),
    staleTime: 15_000,
  });
}

export function useFirmReviewRuns() {
  const api = useApi();
  return useQuery<AgentRun[]>({
    queryKey: ['strategy', 'firm-review-runs'],
    queryFn: async () =>
      normalizeRuns(
        (await api.get<unknown>(`${BASE}/agents/runs/firm-review`)).data,
      ),
    staleTime: 15_000,
  });
}

/** Acknowledge a reviewed firm-level run using the existing state transition. */
export function useTransitionRun() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string; to: 'completed' | 'canceled' }) =>
      normalizeRun(
        (await api.post<unknown>(`${BASE}/agents/runs/${vars.id}/transition`, { to: vars.to })).data,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['strategy', 'firm-review-runs'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'agent-run'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'run-policy'] });
    },
  });
}

export function useWatchReviewState(
  strategyId: string | null,
  enabled: boolean,
) {
  const api = useApi();
  return useQuery<WatchReviewState>({
    queryKey: ['strategy', 'watch-state', strategyId ?? ''],
    enabled: !!strategyId && enabled,
    staleTime: 0,
    queryFn: async () =>
      (
        await api.get<WatchReviewState>(
          `${BASE}/agents/watch/strategies/${strategyId}`,
        )
      ).data,
  });
}

export function usePendingWatchCounts(enabled: boolean) {
  const api = useApi();
  return useQuery<Record<string, number>>({
    queryKey: ['strategy', 'watch-pending-counts'],
    enabled,
    queryFn: async () =>
      (
        await api.get<Record<string, number>>(
          `${BASE}/agents/watch/pending-counts`,
        )
      ).data,
    staleTime: 15_000,
  });
}

/* ----------------------------------------------------------- execution (G) */

export function useExecutionRuns(strategyId?: string | null, enabled = true) {
  const api = useApi();
  const suffix = strategyId
    ? `?strategyId=${encodeURIComponent(strategyId)}`
    : '';
  return useQuery<ExecutionRun[]>({
    queryKey: ['strategy', 'execution-runs', strategyId ?? 'all'],
    enabled,
    queryFn: async () =>
      normalizeExecutionRuns(
        (await api.get<unknown>(`${BASE}/agents/execution/runs${suffix}`)).data,
      ),
    staleTime: 15_000,
    refetchInterval: (query) => query.state.data?.some((run) =>
      run.state === 'queued' || run.state === 'planning' || run.state === 'executing',
    ) ? 3_000 : false,
  });
}

/* ----------------------------------------------------------- shared writes */
/* Mutations that produce a StrategyDetail share one cache-write path so the
 * editor, library and version history never show a stale frame. */
export function useStrategyDetailWrite(strategyId: string) {
  const qc = useQueryClient();
  return (detail: StrategyDetail) => {
    qc.setQueryData(['strategy', 'strategy', strategyId], detail);
    void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    void qc.invalidateQueries({
      queryKey: ['strategy', 'versions', strategyId],
    });
    void qc.invalidateQueries({
      queryKey: ['strategy', 'export-preflight', strategyId],
    });
  };
}

/* ------------------------------------------------- Meri conversation (tab) */

export function conversationKey(strategyId: string, nodeId: string | null) {
  return [
    'strategy',
    'conversation',
    strategyId,
    nodeId ?? 'strategy',
  ] as const;
}

export function useStrategyConversation(
  strategyId: string | null,
  nodeId: string | null,
  enabled = true,
) {
  const api = useApi();
  return useQuery<StrategyChatMessage[]>({
    queryKey: conversationKey(strategyId ?? '', nodeId),
    enabled: !!strategyId && enabled,
    queryFn: async () => {
      const qs = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
      return (
        await api.get<StrategyChatMessage[]>(
          `${BASE}/strategies/${strategyId}/conversations${qs}`,
        )
      ).data;
    },
  });
}

/** Meri edits the plan; the response carries the authoritative StrategyDetail. */
export function useAssistant(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssistantInput) =>
      (
        await api.post<AssistantResponse>(
          `${BASE}/strategies/${strategyId}/assistant`,
          input,
          { timeout: 90_000 },
        )
      ).data,
    onSuccess: (resp) => {
      qc.setQueryData(['strategy', 'strategy', strategyId], resp.strategy);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({
        queryKey: ['strategy', 'versions', strategyId],
      });
      void qc.invalidateQueries({
        queryKey: ['strategy', 'export-preflight', strategyId],
      });
    },
    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: conversationKey(
          strategyId,
          input.scope === 'node' ? (input.nodeId ?? null) : null,
        ),
      });
    },
  });
}

/* ------------------------------------------------------ strategy mutations */

export function useCreateStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateStrategyInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies`, body)).data,
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] }),
  });
}

export function useDraftStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: DraftStrategyInput) =>
      (
        await api.post<StrategyDetail>(`${BASE}/strategies/draft`, body, {
          timeout: 90_000,
        })
      ).data,
    onSuccess: (detail) => {
      qc.setQueryData(['strategy', 'strategy', detail.id], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    },
  });
}

export function useAddNode(strategyId: string) {
  const api = useApi();
  const onOk = useStrategyDetailWrite(strategyId);
  return useMutation({
    mutationFn: async (input: CreateNodeInput) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/nodes`,
          input,
        )
      ).data,
    onSuccess: onOk,
  });
}

export function useUpdateNode(strategyId: string) {
  const api = useApi();
  const onOk = useStrategyDetailWrite(strategyId);
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

export function useDeleteNode(strategyId: string) {
  const api = useApi();
  const onOk = useStrategyDetailWrite(strategyId);
  return useMutation({
    mutationFn: async (nodeId: string) =>
      (
        await api.delete<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/nodes/${nodeId}`,
        )
      ).data,
    onSuccess: onOk,
  });
}

export function useRestoreVersion(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const onOk = useStrategyDetailWrite(strategyId);
  return useMutation({
    mutationFn: async (versionId: string) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/versions/${versionId}/restore`,
        )
      ).data,
    onSuccess: (detail) => {
      onOk(detail);
      void qc.invalidateQueries({
        queryKey: ['strategy', 'detached', strategyId],
      });
      void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
      void qc.invalidateQueries({
        queryKey: ['strategy', 'restore-impact', strategyId],
      });
    },
  });
}

/**
 * Delete a strategy. Server-side this is a NON-DESTRUCTIVE archive (the row is
 * stamped `archivedAt`, never dropped, so version history / change-sets / agent
 * runs / artifact back-links stay resolvable) — the library list already filters
 * archived rows, so it disappears from the UI immediately.
 */
export function useDeleteStrategy() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (strategyId: string) =>
      (
        await api.delete<{ id: string; archivedAt: string }>(
          `${BASE}/strategies/${strategyId}`,
        )
      ).data,
    onSuccess: (result) => {
      // Drop the detail cache entry so a stale back-navigation cannot render a
      // deleted strategy from cache, then refresh the library list.
      qc.removeQueries({ queryKey: ['strategy', 'strategy', result.id] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    },
  });
}

/* ------------------------------------------------------- firm phases write */

export function usePutFirmPhases() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: FirmPhaseInput[]) =>
      (await api.put<FirmPhase[]>(`${BASE}/firm-phases`, { rows })).data,
    onSuccess: (data) => qc.setQueryData(['strategy', 'firm-phases'], data),
  });
}

/* ---------------------------------------------------------- steward writes */

function useStewardInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-facts'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-conflicts'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-health'] });
  };
}

export function useExtractContextFacts() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (documentId: string): Promise<ExtractFactsResult> =>
      normalizeExtractResult(
        (
          await api.post<unknown>(
            `${BASE}/context/documents/${documentId}/extract`,
            undefined,
            {
              timeout: 120_000,
            },
          )
        ).data,
      ),
    onSuccess: invalidate,
  });
}

export function useRejectContextFact() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (factId: string) =>
      (await api.post<unknown>(`${BASE}/context/facts/${factId}/reject`)).data,
    onSuccess: invalidate,
  });
}

export function useResolveContextConflict() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (vars: {
      conflictId: string;
      input: ResolveConflictInput;
    }) =>
      (
        await api.post<unknown>(
          `${BASE}/context/conflicts/${vars.conflictId}/resolve`,
          vars.input,
        )
      ).data,
    onSuccess: invalidate,
  });
}

export function useDismissContextConflict() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (conflictId: string) =>
      (
        await api.post<unknown>(
          `${BASE}/context/conflicts/${conflictId}/dismiss`,
        )
      ).data,
    onSuccess: invalidate,
  });
}

export function useUploadContextDocument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadContextDocumentInput) =>
      normalizeDocument(
        (await api.post<unknown>(`${BASE}/context/documents`, input)).data,
      ),
    onSuccess: (doc) => {
      qc.setQueryData(['strategy', 'context-document', doc.id], doc);
      void qc.invalidateQueries({
        queryKey: ['strategy', 'context-documents'],
      });
    },
  });
}

export function useArchiveContextDocument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      normalizeDocument(
        (await api.post<unknown>(`${BASE}/context/documents/${id}/archive`))
          .data,
      ),
    onSuccess: (doc) => {
      qc.setQueryData(['strategy', 'context-document', doc.id], doc);
      void qc.invalidateQueries({
        queryKey: ['strategy', 'context-documents'],
      });
    },
  });
}

/* ----------------------------------------------------- agent governance (F) */

function useAgentsInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'missions'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-monitoring'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-state'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-pending-counts'] });
  };
}

/** Approve is DISTINCT from apply. opIndexes selects the reviewed subset. */
export function useApproveChangeSet() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input?: ApproveChangeSetInput }) =>
      (
        await api.post<unknown>(
          `${BASE}/agents/change-sets/${vars.id}/approve`,
          vars.input ?? {},
        )
      ).data,
    onSuccess: invalidate,
  });
}

export function useRejectChangeSet() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<unknown>(`${BASE}/agents/change-sets/${id}/reject`)).data,
    onSuccess: invalidate,
  });
}

/** Apply replays the approved subset into ONE revision. 409 = base revision moved. */
export function useApplyChangeSet() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; strategyId: string }) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/agents/change-sets/${vars.id}/apply`,
        )
      ).data,
    onSuccess: (detail, vars) => {
      qc.setQueryData(['strategy', 'strategy', vars.strategyId], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({
        queryKey: ['strategy', 'versions', vars.strategyId],
      });
      invalidate();
    },
    onError: invalidate,
  });
}

/** Undo creates a NEW revision (a real version restore), never a rewind. */
export function useUndoChangeSet() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; strategyId: string }) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/agents/change-sets/${vars.id}/undo`,
        )
      ).data,
    onSuccess: (detail, vars) => {
      qc.setQueryData(['strategy', 'strategy', vars.strategyId], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({
        queryKey: ['strategy', 'versions', vars.strategyId],
      });
      invalidate();
    },
  });
}

/* --------------------------------------------------------- execution (G) */

function useExecutionInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'execution-runs'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'agent-run'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'run-policy'] });
  };
}

/** Prepare the existing node execution plan; execution remains a separate review action. */
export function usePlanExecution() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (input: PlanExecutionInput): Promise<ExecutionRun | null> =>
      normalizeExecutionRunsList(
        (await api.post<unknown>(`${BASE}/agents/execution/plan`, input)).data,
      ),
    onSuccess: invalidate,
  });
}

export function useExecuteRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }) =>
      normalizeExecutionRunsList(
        (
          await api.post<unknown>(
            `${BASE}/agents/execution/runs/${vars.id}/execute`,
          )
        ).data,
      ),
    // F03: invalidate on success AND error. A client timeout aborts the browser
    // request while the server may already be executing / parking Needs
    // attention. onSuccess-only left Ready for review + Execute plan on screen
    // until a full reload.
    onSettled: invalidate,
  });
}

export function useResumeRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input?: ResumeRunInput }) =>
      normalizeExecutionRunsList(
        (
          await api.post<unknown>(
            `${BASE}/agents/execution/runs/${vars.id}/resume`,
            vars.input ?? {},
          )
        ).data,
      ),
    // Same F03 reconciliation: a timed-out resume must still refetch run state.
    onSettled: invalidate,
  });
}

export function useCancelRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }) =>
      normalizeExecutionRunsList(
        (
          await api.post<unknown>(
            `${BASE}/agents/execution/runs/${vars.id}/cancel`,
          )
        ).data,
      ),
    onSuccess: invalidate,
  });
}

/** Retry a failed execution as a fresh planned attempt, ready for human review. */
export function useRetryRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }) =>
      normalizeExecutionRunsList(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/retry`)).data,
      ),
    onSuccess: invalidate,
  });
}

/* Single-run normalize helper (the list normalizer tolerates one-or-many). */
function normalizeExecutionRunsList(data: unknown) {
  const rows = normalizeExecutionRuns(Array.isArray(data) ? data : [data]);
  return rows[0] ?? null;
}

/* ------------------------------------------------- name/option resolution */
/* Strategy rows reference clients and owners by id; the web resolves display
 * names from the main API (api-strategy owns only sp_* tables). Same sources
 * the canonical planner uses. */

export interface ClientLite {
  id: string;
  name: string;
  /** Short-lived signed URL returned by the core Clients API. Preview only. */
  logoUrl?: string | null;
  logoContentType?: string | null;
  logoUploadedAt?: string | null;
}

export function useClientsLite() {
  const api = useApi();
  return useQuery<ClientLite[]>({
    queryKey: ['strategy', 'clients-lite'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
  });
}

const CLIENT_LOGO_MAX_BYTES = 2 * 1024 * 1024;
const CLIENT_LOGO_MAX_SIDE = 4_096;
const CLIENT_LOGO_MAX_PIXELS = 1_000_000;
const CLIENT_LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg']);

interface ClientLogoUploadTarget {
  url: string;
  fields: Record<string, string>;
  s3Key: string;
}

async function clientLogoDimensions(
  file: File,
): Promise<{ width: number; height: number; interlaced: boolean }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    file.type === 'image/png' &&
    bytes.length >= 29 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    String.fromCharCode(...bytes.subarray(12, 16)) === 'IHDR'
  ) {
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      interlaced: bytes[28] === 1,
    };
  }
  if (
    file.type === 'image/jpeg' &&
    bytes.length >= 12 &&
    view.getUint16(0) === 0xffd8
  ) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      if (offset + 4 > bytes.length) break;
      const segmentLength = view.getUint16(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) break;
      if (
        segmentLength >= 7 &&
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker)
      ) {
        return {
          width: view.getUint16(offset + 7),
          height: view.getUint16(offset + 5),
          interlaced: false,
        };
      }
      offset += 2 + segmentLength;
    }
  }
  throw new Error('Choose a valid PNG or JPG logo.');
}

/**
 * Persist a logo on the strategy's linked Client record. This deliberately
 * reuses the canonical Clients upload lifecycle instead of creating a
 * report-only asset: future reports and the Client profile see one mark.
 */
export function useUploadClientLogo(clientId: string | null) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<ClientLite, Error, File>({
    mutationFn: async (file) => {
      if (!clientId) throw new Error('The strategy is not linked to a client.');
      if (!CLIENT_LOGO_MIME_TYPES.has(file.type)) {
        throw new Error('Choose a PNG or JPG logo.');
      }
      if (file.size < 1 || file.size > CLIENT_LOGO_MAX_BYTES) {
        throw new Error('The client logo must be 2 MB or smaller.');
      }
      const dimensions = await clientLogoDimensions(file);
      if (dimensions.interlaced) {
        throw new Error('Choose a standard non-interlaced PNG logo.');
      }
      if (
        dimensions.width < 1 ||
        dimensions.height < 1 ||
        dimensions.width > CLIENT_LOGO_MAX_SIDE ||
        dimensions.height > CLIENT_LOGO_MAX_SIDE ||
        dimensions.width * dimensions.height > CLIENT_LOGO_MAX_PIXELS
      ) {
        throw new Error(
          'Choose a logo no larger than 1 megapixel or 4096 px on either side.',
        );
      }

      const presigned = (
        await api.post<ClientLogoUploadTarget>(
          `/api/clients/${clientId}/logo/upload-url`,
          {
            contentType: file.type,
            contentLength: file.size,
          },
        )
      ).data;

      const form = new FormData();
      for (const [key, value] of Object.entries(presigned.fields)) {
        form.append(key, String(value));
      }
      form.append('file', file);
      const uploaded = await fetch(presigned.url, {
        method: 'POST',
        body: form,
      });
      if (!uploaded.ok)
        throw new Error(`Logo upload failed (${uploaded.status}).`);

      return (
        await api.post<ClientLite>(`/api/clients/${clientId}/logo/confirm`, {
          s3Key: presigned.s3Key,
          contentType: file.type,
        })
      ).data;
    },
    onSuccess: (updated) => {
      qc.setQueryData<ClientLite[]>(['strategy', 'clients-lite'], (current) =>
        current?.map((client) =>
          client.id === updated.id ? { ...client, ...updated } : client,
        ),
      );
      qc.setQueryData<unknown>(['client', updated.id], (current: unknown) =>
        current && typeof current === 'object'
          ? { ...current, ...updated }
          : current,
      );
      void qc.invalidateQueries({ queryKey: ['strategy', 'clients-lite'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'export-preflight'] });
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void qc.invalidateQueries({ queryKey: ['client', updated.id] });
    },
  });
}

export interface TenantMember {
  id: string;
  clerkUserId: string;
  email: string;
  name: string;
}

export function useTenantMembers() {
  const api = useApi();
  return useQuery<TenantMember[]>({
    queryKey: ['strategy', 'tenant-members'],
    queryFn: async () => {
      const rows = (await api.get<TenantMember[]>('/api/tenant-members')).data;
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 300_000,
  });
}

/** Resolve a Clerk user id to a display name, falling back gracefully. */
export function memberName(
  members: TenantMember[] | undefined,
  clerkUserId: string | null | undefined,
  fallback = 'Team member',
): string {
  if (!clerkUserId) return 'Unassigned';
  return members?.find((m) => m.clerkUserId === clerkUserId)?.name ?? fallback;
}

/** Resolve a client id to a display name. */
export function clientName(
  clients: ClientLite[] | undefined,
  clientId: string | null | undefined,
): string {
  if (!clientId) return '—';
  return clients?.find((c) => c.id === clientId)?.name ?? 'Client';
}

/* --------------------------------------------------------- overlay additions */

/**
 * GET /strategies/:id/versions — cursor-paginated history for the §7.10c
 * History overlay ("Load older versions"). `useVersions` above returns only
 * the first page's items; this hook keeps the page stack so the overlay can
 * walk the cursor. The key carries a 'pages' suffix: the two hooks return
 * DIFFERENT data shapes (StrategyVersion[] vs VersionsPage[]) and must never
 * share a cache entry. Prefix invalidations on ['strategy','versions',id]
 * still reach both.
 */
export function useVersionsInfinite(strategyId: string | null, enabled = true) {
  const api = useApi();
  return useInfiniteQuery<
    VersionsPage,
    Error,
    VersionsPage[],
    (string | null)[],
    string | null
  >({
    queryKey: ['strategy', 'versions', strategyId, 'pages'],
    enabled: !!strategyId && enabled,
    initialPageParam: null,
    queryFn: async ({ pageParam }) => {
      const qs = pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : '';
      return (
        await api.get<VersionsPage>(
          `${BASE}/strategies/${strategyId}/versions${qs}`,
        )
      ).data;
    },
    getNextPageParam: (last) => last.nextCursor,
    select: (data) => data.pages,
  });
}

/**
 * GET /context/strategies/:id/current-plan → { markdown } — the ONLY export
 * endpoint the strategies API exposes today (§7.10d confirmed gap: PDF/DOCX/
 * PNG generation is not yet available). The Export overlay keeps this
 * disabled and refetches on demand when the user clicks Download, so the
 * file always reflects the plan at click time.
 */
export function useCurrentPlanExport(
  strategyId: string | null,
  enabled = false,
) {
  const api = useApi();
  return useQuery<{ markdown: string }>({
    queryKey: ['strategy', 'current-plan-export', strategyId],
    enabled: !!strategyId && enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      (
        await api.get<{ markdown: string }>(
          `${BASE}/context/strategies/${strategyId}/current-plan`,
        )
      ).data,
  });
}

/* ---------------------------------------------------- executive report export */

export type StrategyExportFormat = 'docx' | 'pptx';
export type StrategyExportAudience = 'client' | 'internal';

export interface StrategyExportOptions {
  format: StrategyExportFormat;
  audience: StrategyExportAudience;
  useClientLogo: boolean;
  includeRoadmap: boolean;
  includeEvidenceAppendix: boolean;
  includeChangeLog: boolean;
  includeInternalNotes: boolean;
  includeAgentHistory: boolean;
  /** Grounded executive prose (server falls back to fact listings when unavailable). */
  includeNarrative: boolean;
  /** Portrait + Washington office cards for targeted congressional offices. */
  includeMemberProfiles: boolean;
}

export interface StrategyExportInput extends StrategyExportOptions {
  /** Optimistic concurrency token returned by the matching preflight. */
  expectedSnapshotHash?: string;
}

export interface StrategyReportHealth {
  score: number;
  label: 'On track' | 'Needs attention' | 'At risk' | 'No steps';
  coveragePct: number;
  groundingPct: number | null;
  timelinessPct: number | null;
  totalNodes: number;
  ownedNodes: number;
  totalGates: number;
  groundedGates: number;
  datedNodes: number;
  overdueNodes: number;
}

export interface StrategyReportSectionReadiness {
  id:
    | 'summary'
    | 'context'
    | 'priorities'
    | 'decisions_risks'
    | 'roadmap'
    | 'accountability'
    | 'evidence';
  label: string;
  state: 'ready' | 'thin' | 'empty' | 'excluded';
  availableCount: number;
  message: string;
}

export interface StrategyExportPreflight {
  report: {
    strategyId: string;
    title: string;
    type: string;
    asOf: string;
    ready: boolean;
    formats: StrategyExportFormat[];
    audience: StrategyExportAudience;
    format: StrategyExportFormat;
    snapshotHash: string;
    readiness: 'ready' | 'review' | 'blocked';
  };
  client: { id: string; name: string };
  version: { id: string | null; createdAt: string | null; note: string | null };
  health: StrategyReportHealth;
  allLiveHealth: StrategyReportHealth;
  logo: {
    available: boolean;
    supported: boolean;
    contentType: string | null;
    url?: string | null;
  };
  counts: {
    nodes: number;
    actions: number;
    decisions: number;
    gates: number;
    milestones: number;
    risks: number;
    artifacts: number;
  };
  inclusion: {
    liveNodes: number;
    includedNodes: number;
    omittedNodes: number;
    includedByStatus: Record<string, number>;
    omittedByStatus: Record<string, number>;
    placeholderNodes: number;
  };
  content: {
    contextDocuments: number;
    excludedContextDocuments: number;
    narrativeSections: number;
    narrativeItems: number;
    contextFacts: number;
    evidenceLinkedNodes: number;
  };
  sections: StrategyReportSectionReadiness[];
  memberOffices: { referenced: number; resolved: number; withPhoto: number };
  narrative: { available: boolean; reason: string | null; requested: boolean };
  warnings: Array<{ code: string; message: string }>;
  errors: Array<{ code: string; message: string }>;
}

export type StrategyExportNarrativeStatus = 'generated' | 'fallback' | 'off';

export interface StrategyExportFile {
  blob: Blob;
  filename: string;
  contentType: string;
  snapshotHash: string | null;
  audience: StrategyExportAudience;
  logoIncluded: boolean;
  narrativeStatus: StrategyExportNarrativeStatus;
  /** "resolved/referenced" member offices, as reported by the server. */
  memberOffices: { resolved: number; referenced: number } | null;
}

function exportFallbackFilename(
  format: StrategyExportFormat,
  audience: StrategyExportAudience,
): string {
  const audienceLabel = audience === 'internal' ? 'internal-working' : 'client';
  return format === 'pptx'
    ? `strategy-executive-briefing-${audienceLabel}.pptx`
    : `strategy-executive-report-${audienceLabel}.docx`;
}

/** Parse both quoted filename= and UTF-8 filename*= response headers. */
export function exportFilenameFromDisposition(
  disposition: string | undefined,
  fallback: string,
): string {
  if (!disposition) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.replace(/^"|"$/g, ''));
    } catch {
      // Fall through to the ordinary filename token.
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(disposition)?.[1];
  const bare = /filename=([^;\s]+)/i.exec(disposition)?.[1];
  return quoted ?? bare ?? fallback;
}

export function useStrategyExportPreflight(
  strategyId: string | null,
  options: StrategyExportOptions,
  enabled = true,
) {
  const api = useApi();
  return useQuery<StrategyExportPreflight>({
    queryKey: ['strategy', 'export-preflight', strategyId, options],
    enabled: !!strategyId && enabled,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const query = new URLSearchParams({
        format: options.format,
        audience: options.audience,
        useClientLogo: String(options.useClientLogo),
        includeRoadmap: String(options.includeRoadmap),
        includeEvidenceAppendix: String(options.includeEvidenceAppendix),
        includeChangeLog: String(options.includeChangeLog),
        includeInternalNotes: String(options.includeInternalNotes),
        includeAgentHistory: String(options.includeAgentHistory),
        includeNarrative: String(options.includeNarrative),
        includeMemberProfiles: String(options.includeMemberProfiles),
      });
      return (
        await api.get<StrategyExportPreflight>(
          `${BASE}/strategies/${strategyId}/reports/preflight?${query.toString()}`,
        )
      ).data;
    },
  });
}

/** Synchronous, deterministic server render. The Blob is never query-cached. */
export function useGenerateStrategyExport(strategyId: string | null) {
  const api = useApi();
  return useMutation<StrategyExportFile, Error, StrategyExportInput>({
    mutationFn: async (input) => {
      if (!strategyId) throw new Error('The strategy could not be identified.');
      const response = await api.post<Blob>(
        `${BASE}/strategies/${strategyId}/reports/export`,
        input,
        { responseType: 'blob', timeout: 120_000 },
      );
      const disposition = response.headers['content-disposition'] as
        | string
        | undefined;
      const contentType =
        (response.headers['content-type'] as string | undefined) ??
        'application/octet-stream';
      const responseAudience = response.headers['x-report-audience'];
      const narrativeHeader = response.headers['x-report-narrative'];
      const memberHeader = response.headers['x-report-member-offices'];
      const memberMatch =
        typeof memberHeader === 'string'
          ? /^(\d+)\/(\d+)$/.exec(memberHeader)
          : null;
      return {
        blob: response.data,
        filename: exportFilenameFromDisposition(
          disposition,
          exportFallbackFilename(input.format, input.audience),
        ),
        contentType,
        snapshotHash:
          (response.headers['x-report-snapshot-hash'] as string | undefined) ??
          null,
        audience: responseAudience === 'internal' ? 'internal' : 'client',
        logoIncluded: response.headers['x-report-logo-included'] === 'true',
        narrativeStatus:
          narrativeHeader === 'generated' || narrativeHeader === 'fallback'
            ? narrativeHeader
            : 'off',
        memberOffices: memberMatch
          ? {
              resolved: Number(memberMatch[1]),
              referenced: Number(memberMatch[2]),
            }
          : null,
      };
    },
  });
}

/* --------------------------------------------------- Phase 4 Watch hooks */
/* These mirror the canonical api.ts Watch hooks so the vNext editor can
 * surface real Watch proposal cards, not just a count. The query/mutation
 * shapes are server-computed presentation types (types.ts) — no tolerant
 * normalizer needed, same as the canonical surface. */

function watchStateKey(strategyId: string) {
  return ['strategy', 'watch-state', strategyId] as const;
}

function useWatchInvalidate(strategyId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'missions'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-monitoring'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-state'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'watch-pending-counts'] });
    void qc.invalidateQueries({
      queryKey: ['strategy', 'versions', strategyId],
    });
    void qc.invalidateQueries({ queryKey: conversationKey(strategyId, null) });
  };
}

/** POST /agents/watch/strategies/:id/revalidate — panel-open / "Check now". */
export function useRevalidateWatch(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useWatchInvalidate(strategyId);
  return useMutation<WatchReviewState, Error, boolean | void>({
    mutationFn: async (force) =>
      (
        await api.post<WatchReviewState>(
          `${BASE}/agents/watch/strategies/${strategyId}/revalidate`, undefined, { timeout: 120_000, params: force ? { force: true } : undefined },
        )
      ).data,
    onSuccess: (state) => {
      qc.setQueryData(watchStateKey(strategyId), state);
      invalidate();
    },
  });
}

/** POST /agents/watch/proposals/:id/accept — this call IS the approval. */
export function useAcceptWatchProposal(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useWatchInvalidate(strategyId);
  return useMutation({
    mutationFn: async (proposalId: string) =>
      (
        await api.post<WatchAcceptResult>(
          `${BASE}/agents/watch/proposals/${proposalId}/accept`,
        )
      ).data,
    onSuccess: (res) => {
      qc.setQueryData(['strategy', 'strategy', strategyId], res.strategy);
      qc.setQueryData(watchStateKey(strategyId), res.state);
      invalidate();
    },
  });
}

/** POST /agents/watch/proposals/:id/dismiss — permanent suppression. */
export function useDismissWatchProposal(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useWatchInvalidate(strategyId);
  return useMutation({
    mutationFn: async (proposalId: string) =>
      (
        await api.post<WatchReviewState>(
          `${BASE}/agents/watch/proposals/${proposalId}/dismiss`,
        )
      ).data,
    onSuccess: (state) => {
      qc.setQueryData(watchStateKey(strategyId), state);
      invalidate();
    },
  });
}

/** POST /agents/watch/strategies/:id/accept-all — one dependency-ordered batch. */
export function useAcceptAllWatchProposals(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useWatchInvalidate(strategyId);
  return useMutation({
    mutationFn: async (input: AcceptAllWatchInput) =>
      (
        await api.post<WatchAcceptResult>(
          `${BASE}/agents/watch/strategies/${strategyId}/accept-all`,
          input,
        )
      ).data,
    onSuccess: (res) => {
      qc.setQueryData(['strategy', 'strategy', strategyId], res.strategy);
      qc.setQueryData(watchStateKey(strategyId), res.state);
      invalidate();
    },
  });
}

/* ------------------------------------------------------- Mission hooks */
/** POST /agents/missions — create a standing mission (starts draft; PATCH to activate). */
export function useCreateMission() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (input: CreateMissionInput) =>
      normalizeMission(
        (await api.post<unknown>(`${BASE}/agents/missions`, input)).data,
      ),
    onSuccess: invalidate,
  });
}

/** PATCH /agents/missions/:id — state moves (draft→active, active⇄paused) etc. */
export function useUpdateMission() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input: UpdateMissionInput }) =>
      normalizeMission(
        (
          await api.patch<unknown>(
            `${BASE}/agents/missions/${vars.id}`,
            vars.input,
          )
        ).data,
      ),
    onSuccess: invalidate,
  });
}

/** POST /agents/missions/:id/run-check — the Stage F on-demand Watcher check. */
export function useRunCheck() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (missionId: string): Promise<RunCheckResult> =>
      normalizeRunCheck(
        (
          await api.post<unknown>(
            `${BASE}/agents/missions/${missionId}/run-check`,
            undefined,
            {
              timeout: 120_000,
            },
          )
        ).data,
      ),
    onSuccess: invalidate,
  });
}

/* ----------------------------------------- Reference calendar fork (REF-5) */

/** One row of a tenant's forked reference calendar. Mirrors ReferenceForkDto. */
export interface ReferenceForkRow {
  label: string;
  startsOn?: string | null;
  endsOn?: string | null;
  fy?: number | null;
  tone?: string | null;
}

/**
 * PUT /reference-calendars/:kind — fork-on-edit (api-strategy ReferenceService.fork).
 *
 * The body REPLACES every override row for that kind, so callers must send the
 * complete set, not a delta. The server answers with the merged calendars
 * (fork applied), which goes straight into the GET cache.
 *
 * `congress` maps to `congress_milestone` and requires startsOn AND endsOn on
 * every row, with endsOn strictly after startsOn. `ppbe` maps to
 * `ppbe_current_phase` (fy + label, no dates) — NOT to `ppbe_lane_bar`, which
 * is what the PPBE band on the timeline actually draws, so the PPBE bars are
 * not editable through this route.
 */
export function useForkReferenceCalendar(kind: 'congress' | 'ppbe') {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: ReferenceForkRow[]) =>
      (
        await api.put<ReferenceCalendars>(
          `${BASE}/reference-calendars/${kind}`,
          { rows },
        )
      ).data,
    onSuccess: (data) => {
      qc.setQueryData(['strategy', 'reference-calendars'], data);
    },
  });
}

/* --------------------------------------------- Context gap dismiss */
/** POST /strategies/:id/conversations/context-gaps/:messageId/dismiss. */
export function useDismissContextGap(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { messageId: string; nodeId: string | null }) =>
      (
        await api.post<StrategyChatMessage>(
          `${BASE}/strategies/${strategyId}/conversations/context-gaps/${vars.messageId}/dismiss`,
        )
      ).data,
    onSuccess: (_msg, vars) => {
      void qc.invalidateQueries({
        queryKey: conversationKey(strategyId, vars.nodeId),
      });
    },
  });
}

/* --------------------------------------------- Record artifact back-link */
/** POST /strategies/:id/nodes/:nodeId/artifacts — record a node→Capiro back-link (RTE-3). */
export function useRecordArtifact(strategyId: string) {
  const api = useApi();
  const onOk = useStrategyDetailWrite(strategyId);
  return useMutation({
    mutationFn: async (vars: { nodeId: string; input: RecordArtifactInput }) =>
      (
        await api.post<StrategyDetail>(
          `${BASE}/strategies/${strategyId}/nodes/${vars.nodeId}/artifacts`,
          vars.input,
        )
      ).data,
    onSuccess: onOk,
  });
}

/** Human approval produces a new document revision and invalidates every derived context view. */
export function useApproveContextDocument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, expectedChecksum }: { id: string; expectedChecksum: string }) =>
      normalizeDocument((await api.post<unknown>(`${BASE}/context/documents/${id}/approve`, { expectedChecksum })).data),
    onSuccess: (doc) => {
      void qc.invalidateQueries({ queryKey: ['strategy'] });
      qc.setQueryData(['strategy', 'context-document', doc.id], doc);
    },
  });
}

/** Eligibility uses the same service gates as planning and creates no mission or run. */
export function useExecutionPreflight(strategyId: string, nodeId: string, nodeUpdatedAt?: string) {
  const api = useApi();
  return useQuery<ExecutionPreflight>({
    queryKey: ['strategy', 'execution-preflight', strategyId, nodeId, nodeUpdatedAt],
    enabled: !!strategyId && !!nodeId,
    staleTime: 0,
    queryFn: async () => (await api.get<ExecutionPreflight>(`${BASE}/agents/execution/preflight`, { params: { strategyId, nodeId } })).data,
  });
}

export function useWatchMonitoring(strategyId: string) {
  const api = useApi();
  return useQuery<WatchMonitoring>({
    queryKey: ['strategy', 'watch-monitoring', strategyId],
    enabled: !!strategyId,
    staleTime: 0,
    queryFn: async () => (await api.get<WatchMonitoring>(`${BASE}/agents/watch/strategies/${strategyId}/monitoring`)).data,
  });
}

export function useConfigureWatchMonitoring(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useWatchInvalidate(strategyId);
  return useMutation({
    mutationFn: async (mode: 'paused' | 'manual' | 'daily' | 'weekly') =>
      (await api.patch<WatchMonitoring>(`${BASE}/agents/watch/strategies/${strategyId}/monitoring`, { mode })).data,
    onSuccess: (data) => { qc.setQueryData(['strategy', 'watch-monitoring', strategyId], data); invalidate(); },
  });
}

export function useRunPolicy(runId: string, enabled = true) {
  const api = useApi();
  return useQuery<RunPolicy>({
    queryKey: ['strategy', 'run-policy', runId],
    enabled: !!runId && enabled,
    queryFn: async () => (await api.get<RunPolicy>(`${BASE}/agents/execution/runs/${runId}/policy`)).data,
  });
}

export function useReconcileRun() {
  const api = useApi();
  const qc = useQueryClient();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async ({ id }: { id: string }) => (await api.post<ReconcileResult>(`${BASE}/agents/execution/runs/${id}/reconcile`)).data,
    onSuccess: (_result, { id }) => { invalidate(); void qc.invalidateQueries({ queryKey: ['strategy', 'run-policy', id] }); },
  });
}
