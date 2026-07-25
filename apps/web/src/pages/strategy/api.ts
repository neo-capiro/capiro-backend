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
  DetachedSurface,
  DraftStrategyInput,
  ExecutionRun,
  ExtractFactsResult,
  FirmPhase,
  FirmPhaseInput,
  PatchStrategyInput,
  PlanExecutionInput,
  RecordArtifactInput,
  ReferenceCalendars,
  ReferenceForkRow,
  ReconcileResult,
  ResolveConflictInput,
  RestoreImpact,
  ResumeRunInput,
  RunCheckResult,
  RunPolicy,
  StrategyDetail,
  StrategyListItem,
  UpdateMissionInput,
  UpdateNodeInput,
  UploadContextDocumentInput,
  VersionsPage,
} from './types.js';
import {
  normalizeChangeSets,
  normalizeExecutionRun,
  normalizeExecutionRuns,
  normalizeMission,
  normalizeMissions,
  normalizeRun,
  normalizeRunCheck,
  normalizeRuns,
} from './agents/agent-utils.js';
import {
  normalizeConflicts,
  normalizeContextHealth,
  normalizeDocument,
  normalizeDocumentList,
  normalizeExtractResult,
  normalizeFacts,
  normalizeLocate,
  normalizeSections,
} from './context/context-utils.js';

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

/** POST /strategies/:id/nodes/:nodeId/artifacts — record a node→Capiro back-link (RTE-3). */
export function useRecordArtifact(strategyId: string) {
  const api = useApi();
  const onOk = useDetailWriteHandlers(strategyId);
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

/**
 * GET /strategies/:id/versions/:versionId/restore-impact — P0-1 impact preview.
 * Read-only; fetched when the restore modal opens for a specific version so the
 * user sees what would be archived/revived/changed BEFORE committing.
 */
export function useRestoreImpact(strategyId: string, versionId: string | null) {
  const api = useApi();
  return useQuery<RestoreImpact>({
    queryKey: ['strategy', 'restore-impact', strategyId, versionId],
    enabled: !!versionId,
    // Always refetch on open: the impact depends on live plan state, which any
    // teammate's edit can move between opening history and confirming a restore.
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

/**
 * GET /strategies/:id/detached — P0-1: steps a restore archived plus their now
 * historical Workspace/Outreach links, so a staged artifact whose step left the
 * live plan stays discoverable instead of silently disappearing.
 */
export function useDetachedSurface(strategyId: string | null, enabled: boolean) {
  const api = useApi();
  return useQuery<DetachedSurface>({
    queryKey: ['strategy', 'detached', strategyId],
    enabled: !!strategyId && enabled,
    queryFn: async () =>
      (await api.get<DetachedSurface>(`${BASE}/strategies/${strategyId}/detached`)).data,
  });
}

/**
 * POST /strategies/:id/versions/:versionId/restore — "Restore as new version"
 * (HIS-2, P0-1). Non-destructive on the server: steps the snapshot omits are
 * archived (never deleted), their artifact links go historical, and the restore is
 * recorded as an applied change-set so it has a one-click Undo.
 *
 * Invalidates the detached surface and the change-set lists too — a restore adds
 * rows to both.
 */
export function useRestoreVersion(strategyId: string) {
  const api = useApi();
  const qc = useQueryClient();
  const onOk = useDetailWriteHandlers(strategyId);
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

/*
 * ---- Stage D: context documents (/strategy-api/context/*) ----
 * Agentic-surface routes (TenantGuard + StrategyPlannerGuard + AgenticGuard
 * server-side; the /me features.agenticMeri flag is the UI belt). Responses
 * pass through the tolerant normalizers in context/context-utils.ts.
 */

/**
 * GET /strategy-api/context/documents — the whole tenant library (client
 * filter is client-side). includeStale=true: the server default EXCLUDES
 * stale rows (correct for downstream pack consumers), but the library is the
 * management surface — stale docs must stay visible (amber Stale chip) and
 * archivable, never silently vanish.
 */
export function useContextDocuments() {
  const api = useApi();
  return useQuery<ContextDocumentListItem[]>({
    queryKey: ['strategy', 'context-documents'],
    queryFn: async () =>
      normalizeDocumentList((await api.get<unknown>(`${BASE}/context/documents?includeStale=true`)).data),
    staleTime: 30_000,
  });
}

/** GET /strategy-api/context/documents/:id — full document incl. markdown body. */
export function useContextDocument(id: string | null) {
  const api = useApi();
  return useQuery<ContextDocumentDetail>({
    queryKey: ['strategy', 'context-document', id],
    enabled: !!id,
    queryFn: async () =>
      normalizeDocument((await api.get<unknown>(`${BASE}/context/documents/${id}`)).data),
  });
}

/**
 * POST /strategy-api/context/documents — upload raw markdown (front-matter
 * included). A 400 carries field-level validation errors (the modal renders
 * them via parseUploadError). The created doc's `supersedesId` is set when it
 * replaced an active document of the same template/scope.
 */
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

/** POST /strategy-api/context/documents/:id/archive — retire a document. */
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

/** GET /strategy-api/context/documents/:id/sections — heading/row anchors. */
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

/** GET /strategy-api/context/documents/:id/locate?ref=… — exact source lines (provenance without an LLM). */
export function useContextLocate(id: string | null, ref: string | null) {
  const api = useApi();
  return useQuery<ContextLocateResult>({
    queryKey: ['strategy', 'context-locate', id, ref],
    enabled: !!id && !!ref,
    queryFn: async () =>
      normalizeLocate(
        (
          await api.get<unknown>(
            `${BASE}/context/documents/${id}/locate?ref=${encodeURIComponent(ref ?? '')}`,
          )
        ).data,
        ref ?? '',
      ),
    staleTime: 30_000,
  });
}

/*
 * ---- Stage E: the Context Steward (/strategy-api/context/{facts,conflicts,health}) ----
 * Same guard stack + agenticMeri UI belt as the Stage D document routes. The
 * Steward never mutates strategy nodes — reject/resolve/dismiss/extract touch
 * only the sp_context_* tables. Responses pass through the tolerant Stage E
 * normalizers in context/context-utils.ts.
 */

/** Invalidate every Steward read after a steward write (facts/conflicts/health move together). */
function useStewardInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-facts'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-conflicts'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'context-health'] });
  };
}

/** GET /strategy-api/context/facts — the whole tenant fact ledger (filters are client-side). */
export function useContextFacts() {
  const api = useApi();
  return useQuery<ContextFact[]>({
    queryKey: ['strategy', 'context-facts'],
    queryFn: async () => normalizeFacts((await api.get<unknown>(`${BASE}/context/facts`)).data),
    staleTime: 30_000,
  });
}

/** GET /strategy-api/context/conflicts — fact disagreements (open + history). */
export function useContextConflicts() {
  const api = useApi();
  return useQuery<ContextConflict[]>({
    queryKey: ['strategy', 'context-conflicts'],
    queryFn: async () =>
      normalizeConflicts((await api.get<unknown>(`${BASE}/context/conflicts`)).data),
    staleTime: 30_000,
  });
}

/** GET /strategy-api/context/health?clientId=… — per-client Steward context health. */
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

/**
 * POST /strategy-api/context/documents/:id/extract — run the Steward's
 * structured extraction over one document (LLM call — generous timeout). A 403
 * carries the steward-flag reason in the body (surfaced via errorMessage).
 */
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

/** POST /strategy-api/context/facts/:id/reject — reject without editing the source doc. */
export function useRejectContextFact() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (factId: string) =>
      (await api.post<unknown>(`${BASE}/context/facts/${factId}/reject`)).data,
    onSuccess: invalidate,
  });
}

/** POST /strategy-api/context/conflicts/:id/resolve — pick the controlling fact + required note. */
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

/** POST /strategy-api/context/conflicts/:id/dismiss — close a non-issue conflict. */
export function useDismissContextConflict() {
  const api = useApi();
  const invalidate = useStewardInvalidate();
  return useMutation({
    mutationFn: async (conflictId: string) =>
      (await api.post<unknown>(`${BASE}/context/conflicts/${conflictId}/dismiss`)).data,
    onSuccess: invalidate,
  });
}

/*
 * ---- Stage F: the agent surface (/strategy-api/agents/*) ----
 * Same guard stack as Stages D/E (TenantGuard + StrategyPlannerGuard +
 * AgenticGuard server-side; features.agenticMeri is the UI belt — the server
 * additionally enforces the Watcher/auto-apply flags per route). Responses
 * pass through the tolerant Stage F normalizers in agents/agent-utils.ts.
 */

/** Every ChangeSet list is stale after any change-set/mission write. */
function useAgentsInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'change-sets'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'missions'] });
  };
}

/** GET /agents/change-sets?status=…&strategyId=… — the review-queue lists. */
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

/** POST /agents/change-sets/:id/approve — opIndexes ⇒ selective approval subset. */
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

/** POST /agents/change-sets/:id/reject — from proposed or approved. */
export function useRejectChangeSet() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<unknown>(`${BASE}/agents/change-sets/${id}/reject`)).data,
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/change-sets/:id/apply — replays the approved ops through the
 * Meri pipeline and returns the authoritative StrategyDetail. A 409 means the
 * plan moved since the proposal was pinned: the server has ALREADY marked the
 * row stale, so the lists are invalidated on error too (the caller surfaces
 * the regenerate hint).
 */
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

/**
 * POST /agents/change-sets/:id/undo — the first-class Undo surface: restores
 * the pinned pre-apply version (a real version restore, cut + logged) and
 * returns the authoritative StrategyDetail. 409 ⇒ the head moved since the
 * apply — recover via version history instead.
 */
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

/** GET /agents/missions?strategyId=… — the strategy's standing missions. */
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

/** POST /agents/missions — create a standing mission (starts draft; PATCH to activate). */
export function useCreateMission() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (input: CreateMissionInput) =>
      normalizeMission((await api.post<unknown>(`${BASE}/agents/missions`, input)).data),
    onSuccess: invalidate,
  });
}

/** PATCH /agents/missions/:id — state moves (draft→active, active⇄paused) etc. */
export function useUpdateMission() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input: UpdateMissionInput }) =>
      normalizeMission((await api.patch<unknown>(`${BASE}/agents/missions/${vars.id}`, vars.input)).data),
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/missions/:id/run-check — the Stage F on-demand Watcher check
 * (deterministic deadline/verifier pass; generous timeout for any LLM
 * interpretation). New proposals land as change-sets ⇒ invalidate the lists.
 */
export function useRunCheck() {
  const api = useApi();
  const invalidate = useAgentsInvalidate();
  return useMutation({
    mutationFn: async (missionId: string): Promise<RunCheckResult> =>
      normalizeRunCheck(
        (
          await api.post<unknown>(`${BASE}/agents/missions/${missionId}/run-check`, undefined, {
            timeout: 120_000,
          })
        ).data,
      ),
    onSuccess: invalidate,
  });
}

/** GET /agents/runs/:id — one run (the queue reads findings off a change-set's runId). */
export function useAgentRun(runId: string | null) {
  const api = useApi();
  return useQuery<AgentRun | null>({
    queryKey: ['strategy', 'agent-run', runId],
    enabled: !!runId,
    queryFn: async () => normalizeRun((await api.get<unknown>(`${BASE}/agents/runs/${runId}`)).data),
    staleTime: 30_000,
  });
}

/**
 * GET /agents/runs/firm-review — firm-level (no-strategy) Watcher runs in
 * ready_for_review that carry findings. The F2 firm-calendar placeholder mints
 * these WITHOUT a change-set, so the change-set lists never surface them — the
 * review queue's firm-level section is their only viewer.
 */
export function useFirmReviewRuns() {
  const api = useApi();
  return useQuery<AgentRun[]>({
    queryKey: ['strategy', 'firm-review-runs'],
    queryFn: async () =>
      normalizeRuns((await api.get<unknown>(`${BASE}/agents/runs/firm-review`)).data),
    staleTime: 15_000,
  });
}

/**
 * POST /agents/runs/:id/transition — the review queue acknowledges a firm-level
 * run (ready_for_review -> completed; the server enforces RUN_TRANSITIONS).
 * Invalidates the firm-review list (the acknowledged run drains out) and the
 * single-run reads.
 */
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
    },
  });
}

/*
 * ---- Stage G: the Execution Agent (/strategy-api/agents/execution/*) ----
 * Same guard stack as Stages D–F (TenantGuard + StrategyPlannerGuard +
 * AgenticGuard server-side; features.agenticMeri is the UI belt — the server
 * additionally enforces the per-intent executionAgentWorkspace /
 * executionAgentOutreach flags per route, so a tenant on agenticMeri without
 * the execution flag simply sees the plan/execute call 403 with the server's
 * reason). Rows pass through the tolerant normalizers in agents/agent-utils.ts.
 *
 * SAFETY (plan §G): none of these hooks performs an external send. Execute
 * STAGES artifacts; Resume carries the (inert) send-approval token — the actual
 * send stays hard-disabled behind STRATEGY_EXECUTION_SEND_ENABLED (never set)
 * until Stage H.
 */

/** Every execution list is stale after any plan/execute/resume write. */
function useExecutionInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['strategy', 'execution-runs'] });
    void qc.invalidateQueries({ queryKey: ['strategy', 'agent-run'] });
  };
}

/** GET /agents/execution/runs?strategyId=… — the Execution review list. */
export function useExecutionRuns(strategyId?: string | null, enabled = true) {
  const api = useApi();
  const suffix = strategyId ? `?strategyId=${encodeURIComponent(strategyId)}` : '';
  return useQuery<ExecutionRun[]>({
    queryKey: ['strategy', 'execution-runs', strategyId ?? 'all'],
    enabled,
    queryFn: async () =>
      normalizeExecutionRuns((await api.get<unknown>(`${BASE}/agents/execution/runs${suffix}`)).data),
    staleTime: 15_000,
  });
}

/**
 * POST /agents/execution/plan — stage a node's execution plan for review
 * (workspace_draft / outreach_record). Returns the created run; the caller
 * links into the Execution review to act on it. The caller bearer is forwarded
 * by the shared axios interceptor — a bearerless (scheduler/system) plan is a
 * server concern that parks waiting_for_input, never a bearerless external hop.
 */
export function usePlanExecution() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (input: PlanExecutionInput): Promise<ExecutionRun | null> =>
      normalizeExecutionRun((await api.post<unknown>(`${BASE}/agents/execution/plan`, input)).data),
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/execution/runs/:id/execute — replay a reviewed plan: STAGE the
 * artifacts (WsDraft / OutreachRecord). A run that cannot proceed comes back
 * (or a 4xx) parked waiting_for_input with a precise reason (version drift /
 * ineligible / material conflict / requires interactive session); a staged
 * outreach parks awaiting the (inert) send approval. NEVER sends externally.
 */
export function useExecuteRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }): Promise<ExecutionRun | null> =>
      normalizeExecutionRun(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/execute`)).data,
      ),
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/execution/runs/:id/resume — resume a parked run once its blocker
 * clears (e.g. re-planned against the current head, or picked up in an
 * interactive session). Carries the send-approval token for the Stage-H send
 * path; in Stage G the send remains hard-disabled server-side, so resuming a
 * send-approval park cannot cause an external send.
 */
export function useResumeRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; input?: ResumeRunInput }): Promise<ExecutionRun | null> =>
      normalizeExecutionRun(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/resume`, vars.input ?? {}))
          .data,
      ),
    onSuccess: invalidate,
  });
}

/*
 * ---- P0-2 run recovery -------------------------------------------------------
 *
 * The audit's missing controls for a stranded run. None of these create or send
 * anything: cancel/mark-failed only move run state, retry mints a fresh attempt
 * that must be re-planned and re-approved, and reconcile only reads what already
 * happened and records it.
 */

/**
 * GET /agents/execution/runs/:id/policy — the allowed-next-actions list + the
 * plain-words state reason, straight from the server's state machine. The recovery
 * controls render from this so an on-screen button can never offer something the
 * server would reject.
 */
export function useRunPolicy(runId: string | null, enabled = true) {
  const api = useApi();
  return useQuery<RunPolicy>({
    queryKey: ['strategy', 'run-policy', runId],
    enabled: !!runId && enabled,
    queryFn: async () =>
      (await api.get<RunPolicy>(`${BASE}/agents/execution/runs/${runId}/policy`)).data,
  });
}

/** GET /agents/execution/runs/:id/attempts — every attempt in this run's family. */
export function useRunAttempts(runId: string | null, enabled = true) {
  const api = useApi();
  return useQuery<ExecutionRun[]>({
    queryKey: ['strategy', 'run-attempts', runId],
    enabled: !!runId && enabled,
    queryFn: async () =>
      normalizeExecutionRuns(
        (await api.get<unknown>(`${BASE}/agents/execution/runs/${runId}/attempts`)).data,
      ),
  });
}

/** POST /agents/execution/runs/:id/cancel — stop a run that is not yet terminal. */
export function useCancelRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }): Promise<ExecutionRun | null> =>
      normalizeExecutionRun(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/cancel`)).data,
      ),
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/execution/runs/:id/retry — mints a NEW attempt and supersedes the
 * prior one when it was still open. This is what makes retry possible at all: the
 * (tenant, idempotencyKey) unique constraint meant re-triggering the same key
 * returned the same stuck run forever. The new run inherits the execution INTENT
 * only — never a prior approval or staged result.
 */
export function useRetryRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string }): Promise<ExecutionRun | null> =>
      normalizeExecutionRun(
        (await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/retry`)).data,
      ),
    onSuccess: invalidate,
  });
}

/** POST /agents/execution/runs/:id/mark-failed — declare a stuck run dead. */
export function useMarkRunFailed() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; reason?: string }): Promise<ExecutionRun | null> =>
      normalizeExecutionRun(
        (
          await api.post<unknown>(`${BASE}/agents/execution/runs/${vars.id}/mark-failed`, {
            ...(vars.reason ? { reason: vars.reason } : {}),
          })
        ).data,
      ),
    onSuccess: invalidate,
  });
}

/**
 * POST /agents/execution/runs/:id/reconcile — work out what actually happened to a
 * stranded run and apply at most one repair. Returns the findings so the UI can
 * explain the outcome instead of just refreshing.
 */
export function useReconcileRun() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: string }): Promise<ReconcileResult> =>
      (await api.post<ReconcileResult>(`${BASE}/agents/execution/runs/${vars.id}/reconcile`)).data,
    onSuccess: (_res, vars) => {
      invalidate();
      void qc.invalidateQueries({ queryKey: ['strategy', 'run-policy', vars.id] });
    },
  });
}

/**
 * POST /agents/execution/runs/:id/resolve-reservation — the operator's answer to
 * the ONE case reconciliation cannot decide: a staging reservation with no recorded
 * artifact. 'adopt' links a document the operator found; 'release' frees the slot
 * after confirming nothing was created. Both are unrecoverable if wrong, which is
 * why the server requires an explicit human choice rather than guessing.
 */
export function useResolveReservation() {
  const api = useApi();
  const invalidate = useExecutionInvalidate();
  return useMutation({
    mutationFn: async (vars: { id: string; action: 'adopt' | 'release'; artifactRef?: string }) =>
      (
        await api.post<unknown>(
          `${BASE}/agents/execution/runs/${vars.id}/resolve-reservation`,
          { action: vars.action, ...(vars.artifactRef ? { artifactRef: vars.artifactRef } : {}) },
        )
      ).data,
    onSuccess: invalidate,
  });
}
