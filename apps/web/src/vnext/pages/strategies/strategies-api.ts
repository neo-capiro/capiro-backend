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
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
/* NOTE (overlay build, 2026-08): this import previously read
 * '../../../../../lib/use-api.js' (5 levels up → apps/lib/, which does not
 * exist — verified with ls). use-api lives at apps/web/src/lib/use-api.ts,
 * 3 levels up from this file. Fixed so the overlay set can import these hooks. */
import { useApi } from '../../../lib/use-api.js';
import type {
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
  CreateNodeInput,
  CreateStrategyInput,
  DraftStrategyInput,
  ExecutionRun,
  ExtractFactsResult,
  FirmPhase,
  FirmPhaseInput,
  ReferenceCalendars,
  ResolveConflictInput,
  RestoreImpact,
  ResumeRunInput,
  StrategyDetail,
  StrategyListItem,
  StrategyChatMessage,
  StrategyVersion,
  UpdateNodeInput,
  UploadContextDocumentInput,
  VersionsPage,
  WatchReviewState,
} from '../../../pages/strategy/types.js';
import {
  normalizeChangeSets,
  normalizeExecutionRuns,
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

const BASE = '/strategy-api';

/* ---------------------------------------------------------------- strategies */

export function useStrategies() {
  const api = useApi();
  return useQuery<StrategyListItem[]>({
    queryKey: ['strategy', 'strategies'],
    queryFn: async () => (await api.get<StrategyListItem[]>(`${BASE}/strategies`)).data,
    staleTime: 30_000,
  });
}

export function useStrategy(id: string | null) {
  const api = useApi();
  return useQuery<StrategyDetail>({
    queryKey: ['strategy', 'strategy', id],
    enabled: !!id,
    queryFn: async () => (await api.get<StrategyDetail>(`${BASE}/strategies/${id}`)).data,
  });
}

export function useVersions(strategyId: string | null, enabled = true) {
  const api = useApi();
  return useQuery<StrategyVersion[]>({
    queryKey: ['strategy', 'versions', strategyId],
    enabled: !!strategyId && enabled,
    queryFn: async () =>
      (await api.get<VersionsPage>(`${BASE}/strategies/${strategyId}/versions`)).data.items,
  });
}

export function useRestoreImpact(strategyId: string | null, versionId: string | null) {
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
    queryFn: async () => (await api.get<FirmPhase[]>(`${BASE}/firm-phases`)).data,
    staleTime: 60_000,
  });
}

export function useReferenceCalendars() {
  const api = useApi();
  return useQuery<ReferenceCalendars>({
    queryKey: ['strategy', 'reference-calendars'],
    queryFn: async () => (await api.get<ReferenceCalendars>(`${BASE}/reference-calendars`)).data,
    staleTime: 60_000,
  });
}

/* ------------------------------------------------------------ context (D) */

export function useContextDocuments() {
  const api = useApi();
  return useQuery<ContextDocumentListItem[]>({
    queryKey: ['strategy', 'context-documents'],
    queryFn: async () =>
      normalizeDocumentList(
        (await api.get<unknown>(`${BASE}/context/documents?includeStale=true`)).data,
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
      normalizeDocument((await api.get<unknown>(`${BASE}/context/documents/${id}`)).data),
  });
}

export function useContextSections(id: string | null) {
  const api = useApi();
  return useQuery<ContextSection[]>({
    queryKey: ['strategy', 'context-sections', id],
    enabled: !!id,
    queryFn: async () =>
      normalizeSections((await api.get<unknown>(`${BASE}/context/documents/${id}/sections`)).data),
    staleTime: 30_000,
  });
}

/**
 * GET /context/documents/:id/locate?ref=… — exact 1-based source lines for a
 * fact's `sourceRef` (no LLM). The Resolve-conflict overlay (§7.10f) uses this
 * to render the "exact line evidence" the decision record cites.
 */
export function useContextLocate(documentId: string | null, ref: string | null) {
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

export function useContextFacts() {
  const api = useApi();
  return useQuery<ContextFact[]>({
    queryKey: ['strategy', 'context-facts'],
    queryFn: async () => normalizeFacts((await api.get<unknown>(`${BASE}/context/facts`)).data),
    staleTime: 30_000,
  });
}

export function useContextConflicts() {
  const api = useApi();
  return useQuery<ContextConflict[]>({
    queryKey: ['strategy', 'context-conflicts'],
    queryFn: async () =>
      normalizeConflicts((await api.get<unknown>(`${BASE}/context/conflicts`)).data),
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
        (await api.get<unknown>(`${BASE}/context/health?clientId=${encodeURIComponent(clientId ?? '')}`))
          .data,
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
    queryKey: ['strategy', 'change-sets', filter.status ?? 'all', filter.strategyId ?? 'all'],
    enabled,
    queryFn: async () =>
      normalizeChangeSets((await api.get<unknown>(`${BASE}/agents/change-sets${suffix}`)).data),
    staleTime: 15_000,
  });
}

export function useFirmReviewRuns() {
  const api = useApi();
  return useQuery<AgentRun[]>({
    queryKey: ['strategy', 'firm-review-runs'],
    queryFn: async () =>
      normalizeRuns((await api.get<unknown>(`${BASE}/agents/runs/firm-review`)).data),
    staleTime: 15_000,
  });
}

export function useWatchReviewState(strategyId: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery<WatchReviewState>({
    queryKey: ['strategy', 'watch-state', strategyId ?? ''],
    enabled: !!strategyId && enabled,
    staleTime: 0,
    queryFn: async () =>
      (await api.get<WatchReviewState>(`${BASE}/agents/watch/strategies/${strategyId}`)).data,
  });
}

export function usePendingWatchCounts(enabled: boolean) {
  const api = useApi();
  return useQuery<Record<string, number>>({
    queryKey: ['strategy', 'watch-pending-counts'],
    enabled,
    queryFn: async () =>
      (await api.get<Record<string, number>>(`${BASE}/agents/watch/pending-counts`)).data,
    staleTime: 15_000,
  });
}

/* ----------------------------------------------------------- execution (G) */

export function useExecutionRuns(strategyId?: string | null, enabled = true) {
  const api = useApi();
  const suffix = strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : '';
  return useQuery<ExecutionRun[]>({
    queryKey: ['strategy', 'execution-runs', strategyId ?? 'all'],
    enabled,
    queryFn: async () =>
      normalizeExecutionRuns(
        (await api.get<unknown>(`${BASE}/agents/execution/runs${suffix}`)).data,
      ),
    staleTime: 15_000,
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
    void qc.invalidateQueries({ queryKey: ['strategy', 'versions', strategyId] });
  };
}

/* ------------------------------------------------- Meri conversation (tab) */

export function conversationKey(strategyId: string, nodeId: string | null) {
  return ['strategy', 'conversation', strategyId, nodeId ?? 'strategy'] as const;
}

export function useStrategyConversation(strategyId: string | null, nodeId: string | null, enabled = true) {
  const api = useApi();
  return useQuery<StrategyChatMessage[]>({
    queryKey: conversationKey(strategyId ?? '', nodeId),
    enabled: !!strategyId && enabled,
    queryFn: async () => {
      const qs = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
      return (
        await api.get<StrategyChatMessage[]>(`${BASE}/strategies/${strategyId}/conversations${qs}`)
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
      (await api.post<AssistantResponse>(`${BASE}/strategies/${strategyId}/assistant`, input, { timeout: 90_000 }))
        .data,
    onSuccess: (resp) => {
      qc.setQueryData(['strategy', 'strategy', strategyId], resp.strategy);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'versions', strategyId] });
    },
    onSettled: (_data, _err, input) => {
      void qc.invalidateQueries({
        queryKey: conversationKey(strategyId, input.scope === 'node' ? (input.nodeId ?? null) : null),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] }),
  });
}

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

export function useAddNode(strategyId: string) {
  const api = useApi();
  const onOk = useStrategyDetailWrite(strategyId);
  return useMutation({
    mutationFn: async (input: CreateNodeInput) =>
      (await api.post<StrategyDetail>(`${BASE}/strategies/${strategyId}/nodes`, input)).data,
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
      (await api.delete<StrategyDetail>(`${BASE}/strategies/${strategyId}/nodes/${nodeId}`)).data,
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
      void qc.invalidateQueries({ queryKey: ['strategy', 'detached', strategyId] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'restore-impact', strategyId] });
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
          await api.post<unknown>(`${BASE}/context/documents/${documentId}/extract`, undefined, {
            timeout: 120_000,
          })
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
    mutationFn: async (vars: { conflictId: string; input: ResolveConflictInput }) =>
      (await api.post<unknown>(`${BASE}/context/conflicts/${vars.conflictId}/resolve`, vars.input))
        .data,
    onSuccess: invalidate,
  });
}

export function useDismissContextConflict() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (conflictId: string) =>
      (await api.post<unknown>(`${BASE}/context/conflicts/${conflictId}/dismiss`)).data,
    onSuccess: invalidate,
  });
}

export function useUploadContextDocument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: UploadContextDocumentInput) =>
      normalizeDocument((await api.post<unknown>(`${BASE}/context/documents`, input)).data),
    onSuccess: (doc) => {
      qc.setQueryData(['strategy', 'context-document', doc.id], doc);
      void qc.invalidateQueries({ queryKey: ['strategy', 'context-documents'] });
    },
  });
}

export function useArchiveContextDocument() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      normalizeDocument((await api.post<unknown>(`${BASE}/context/documents/${id}/archive`)).data),
    onSuccess: (doc) => {
      qc.setQueryData(['strategy', 'context-document', doc.id], doc);
      void qc.invalidateQueries({ queryKey: ['strategy', 'context-documents'] });
    },
  });
}

/* ----------------------------------------------------- agent governance (F) */

function useAgentsInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'missions'] });
  };
}

/** Approve is DISTINCT from apply. opIndexes selects the reviewed subset. */
export function useApproveChangeSet() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input?: ApproveChangeSetInput }) =>
      (await api.post<unknown>(`${BASE}/agents/change-sets/${vars.id}/approve`, vars.input ?? {}))
        .data,
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
      (await api.post<StrategyDetail>(`${BASE}/agents/change-sets/${vars.id}/apply`)).data,
    onSuccess: (detail, vars) => {
      qc.setQueryData(['strategy', 'strategy', vars.strategyId], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'versions', vars.strategyId] });
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
      (await api.post<StrategyDetail>(`${BASE}/agents/change-sets/${vars.id}/undo`)).data,
    onSuccess: (detail, vars) => {
      qc.setQueryData(['strategy', 'strategy', vars.strategyId], detail);
      void qc.invalidateQueries({ queryKey: ['strategy', 'strategies'] });
      void qc.invalidateQueries({ queryKey: ['strategy', 'versions', vars.strategyId] });
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
  };
}

export function useExecuteRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }) =>
      normalizeExecutionRunsList(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/execute`)).data,
      ),
    onSuccess: invalidate,
  });
}

export function useResumeRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input?: ResumeRunInput }) =>
      normalizeExecutionRunsList(
        (await api.post<unknown>(
          `${BASE}/agents/execution/runs/${vars.id}/resume`,
          vars.input ?? {},
        )).data,
      ),
    onSuccess: invalidate,
  });
}

export function useCancelRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }) =>
      normalizeExecutionRunsList(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/cancel`)).data,
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
}

export function useClientsLite() {
  const api = useApi();
  return useQuery<ClientLite[]>({
    queryKey: ['strategy', 'clients-lite'],
    queryFn: async () => (await api.get<ClientLite[]>('/api/clients')).data,
    staleTime: 60_000,
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
export function clientName(clients: ClientLite[] | undefined, clientId: string | null | undefined): string {
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
  return useInfiniteQuery<VersionsPage, Error, VersionsPage[], (string | null)[], string | null>({
    queryKey: ['strategy', 'versions', strategyId, 'pages'],
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

/**
 * GET /context/strategies/:id/current-plan → { markdown } — the ONLY export
 * endpoint the strategies API exposes today (§7.10d confirmed gap: PDF/DOCX/
 * PNG generation is not yet available). The Export overlay keeps this
 * disabled and refetches on demand when the user clicks Download, so the
 * file always reflects the plan at click time.
 */
export function useCurrentPlanExport(strategyId: string | null, enabled = false) {
  const api = useApi();
  return useQuery<{ markdown: string }>({
    queryKey: ['strategy', 'current-plan-export', strategyId],
    enabled: !!strategyId && enabled,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () =>
      (await api.get<{ markdown: string }>(`${BASE}/context/strategies/${strategyId}/current-plan`))
        .data,
  });
}
