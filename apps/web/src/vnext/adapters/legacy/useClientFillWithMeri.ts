/**
 * Fill with Meri — client for the enrichment contract (Figma `1244:4222` §4).
 *
 * This is NOT the Meri chat drawer. It starts a durable enrichment run, polls
 * it, and applies explicitly-selected findings. The backend refuses to write
 * anything without a `findingIds[]` list, so "no silent write" is structural
 * rather than a convention this UI has to remember.
 *
 *   POST   /api/clients/:id/fill-with-meri/runs               start
 *   GET    /api/clients/:id/fill-with-meri/latest             resume
 *   GET    /api/clients/:id/fill-with-meri/runs/:runId        poll
 *   POST   /api/clients/:id/fill-with-meri/runs/:runId/apply  apply (user_admin)
 *   POST   /api/clients/:id/fill-with-meri/findings/:id/reject
 *   POST   /api/clients/:id/fill-with-meri/findings/:id/restore
 *   POST   /api/clients/:id/fill-with-meri/runs/:runId/findings/:id/assign-matter
 *          §22/23 follow-up: "Attach to Matter X" / "Create new Matter" on a
 *          still-pending advocacy finding. This IS the review/approval
 *          decision — it commits immediately (record upsert + Matter
 *          assign/lock + finding accepted, atomically on the server side),
 *          not a staged choice applied later by a separate Apply click.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

export type FillRunStatus = 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type FillFindingStatus = 'pending' | 'accepted' | 'rejected' | 'informational';
export type FillFactKind = 'fact' | 'recommendation';
export type FillTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

export interface FillTask {
  id: string;
  runId: string;
  taskType: string;
  taskKey: string;
  status: FillTaskStatus;
  dependsOn: string[];
  attempt: number;
  maxAttempts: number;
  outputSummary: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FillProgress {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface FillEvidence {
  label: string;
  url?: string | null;
  excerpt?: string | null;
  source?: string | null;
  observedAt?: string | null;
}

export interface FillFinding {
  id: string;
  runId: string;
  kind: string;
  targetKey: string;
  source: string;
  factKind: FillFactKind;
  currentValue: unknown;
  proposedValue: unknown;
  evidence: FillEvidence[];
  confidence: number;
  status: FillFindingStatus;
  appliedAt: string | null;
  createdAt: string;
}

export interface FillRun {
  id: string;
  clientId: string;
  status: FillRunStatus;
  requestedSources: string[];
  /** Per-source outcome; the reason `partial` is a real state and not a guess. */
  sourceStates: Record<string, unknown>;
  summary: Record<string, unknown>;
  /** Advanced workflow stage and task ledger. Older runs may omit these. */
  stage?: 'preparing' | 'research' | 'reconciliation' | 'review_ready' | 'failed' | 'cancelled' | string;
  progress?: FillProgress;
  tasks?: FillTask[];
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  findings: FillFinding[];
}

/** The UI states §14 requires, derived rather than tracked by hand. */
export type FillPhase =
  | 'idle'
  | 'preparing'
  | 'researching'
  | 'proposals'
  | 'no-changes'
  | 'context-only'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'permission-denied'
  | 'applying'
  | 'apply-partial'
  | 'applied';

const httpStatus = (error: unknown): number | null => {
  const response = (error as { response?: { status?: number } } | null)?.response;
  return typeof response?.status === 'number' ? response.status : null;
};

export function errorText(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data;
  if (typeof data?.message === 'string') return data.message;
  if (Array.isArray(data?.message)) return data.message.join(', ');
  return error instanceof Error ? error.message : fallback;
}

export function useClientFillWithMeri(clientId: string, open: boolean) {
  const api = useApi();
  const qc = useQueryClient();
  const base = `/api/clients/${clientId}/fill-with-meri`;

  const [runId, setRunId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyOutcome, setApplyOutcome] = useState<{ applied: number; failed: number } | null>(null);

  // Resume an existing run rather than starting a second one on reopen.
  const latest = useQuery<FillRun | null>({
    queryKey: ['client-fill-with-meri', clientId, 'latest'],
    queryFn: async () => (await api.get<FillRun | null>(`${base}/latest`)).data,
    enabled: open,
    retry: false,
  });

  const activeRunId = runId ?? latest.data?.id ?? null;

  const run = useQuery<FillRun>({
    queryKey: ['client-fill-with-meri', clientId, 'run', activeRunId],
    queryFn: async () => (await api.get<FillRun>(`${base}/runs/${activeRunId}`)).data,
    enabled: open && Boolean(activeRunId),
    // Poll only while the server says it is still working.
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
    retry: false,
  });

  const current = run.data ?? latest.data ?? null;

  const start = useMutation({
    mutationFn: async (input: { sources?: string[]; attachmentId?: string; website?: string } = {}) =>
      (
        await api.post<FillRun>(
          `${base}/runs`,
          input.attachmentId
            ? { attachmentId: input.attachmentId }
            : {
                ...(input.sources?.length ? { sources: input.sources } : {}),
                ...(input.website?.trim() ? { website: input.website.trim() } : {}),
              },
        )
      ).data,
    onSuccess: (created) => {
      setRunId(created.id);
      setSelected(new Set());
      setApplyOutcome(null);
      qc.setQueryData(['client-fill-with-meri', clientId, 'run', created.id], created);
      void qc.invalidateQueries({ queryKey: ['client', clientId] });
    },
  });

  const apply = useMutation({
    mutationFn: async (findingIds: string[]) =>
      (await api.post<{ applied?: number; failed?: number }>(`${base}/runs/${activeRunId}/apply`, { findingIds })).data,
    onSuccess: (result, findingIds) => {
      const applied = result?.applied ?? findingIds.length;
      const failed = result?.failed ?? 0;
      setApplyOutcome({ applied, failed });
      // §4: "Apply invalidates/reloads affected client queries." These are the
      // keys every client surface reads, including the canonical profile.
      for (const key of [
        ['client', clientId],
        ['client-people', clientId],
        ['client-capabilities', clientId],
        ['client-facilities', clientId],
        ['client-targets', clientId],
        ['client-attachments', clientId],
        ['client-kb-status', clientId],
        // Advocacy findings write client_advocacy_record rows on apply —
        // the Advocacy History tab reads a different query key than the
        // core profile surfaces above, so it needs its own invalidation
        // or an applied advocacy_record finding leaves the Matters view
        // stale until the user manually reloads.
        ['client-advocacy-matters', clientId],
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void run.refetch();
    },
  });

  const cancel = useMutation({
    mutationFn: async () =>
      (await api.post<FillRun>(`${base}/runs/${activeRunId}/cancel`, {})).data,
    onSuccess: (cancelled) => {
      setRunId(cancelled.id);
      setSelected(new Set());
      setApplyOutcome(null);
      qc.setQueryData(['client-fill-with-meri', clientId, 'run', cancelled.id], cancelled);
      void run.refetch();
    },
  });

  const retryTask = useMutation({
    mutationFn: async (taskId: string) =>
      (await api.post<FillRun>(`${base}/runs/${activeRunId}/tasks/${taskId}/retry`, {})).data,
    onSuccess: (updated) => {
      setRunId(updated.id);
      qc.setQueryData(['client-fill-with-meri', clientId, 'run', updated.id], updated);
      void run.refetch();
    },
  });

  /** Reject a still-pending finding with a reason — never silently drops it.
   *  For an advocacy_record/advocacy_outcome finding this IS the "Not
   *  advocacy" action from product spec §22/23: the finding is marked
   *  rejected and no client_advocacy_record row is ever created for it, so
   *  a human correction that something Meri surfaced is not advocacy takes
   *  effect before any record exists — there is nothing to un-cluster
   *  later. Reuses the existing findings/:id/reject endpoint; no new
   *  backend surface needed for this action. */
  const reject = useMutation({
    mutationFn: async ({ findingId, reason }: { findingId: string; reason?: string }) =>
      (await api.post<FillFinding>(`${base}/findings/${findingId}/reject`, { reason })).data,
    onSuccess: () => {
      void run.refetch();
    },
  });

  const restore = useMutation({
    mutationFn: async (findingId: string) =>
      (await api.post<FillFinding>(`${base}/findings/${findingId}/restore`, {})).data,
    onSuccess: () => {
      void run.refetch();
    },
  });

  /** §22/23 follow-up: "Attach to Matter X" / "Create new Matter" directly
   *  on a still-pending advocacy finding. This IS the review/approval
   *  decision for that finding — it commits immediately server-side (see
   *  `applyAdvocacyFindingToMatter`), not a staged choice applied later by
   *  a separate "Apply" click. Invalidates the same query keys `apply`
   *  does (the finding just became `accepted`, exactly like a checkbox+
   *  Apply would have) plus `client-advocacy-matters` for the Matter list/
   *  detail/Timeline views, since a Matter may have just been created or
   *  gained a new record. */
  const assignMatter = useMutation({
    mutationFn: async ({
      findingId,
      target,
    }: {
      findingId: string;
      target: { matterId: string } | { newMatter: { title: string; matterType?: string; summary?: string | null } };
    }) =>
      (
        await api.post<{ findingId: string; matterId: string | null; alreadyApplied: boolean }>(
          `${base}/runs/${activeRunId}/findings/${findingId}/assign-matter`,
          target,
        )
      ).data,
    onSuccess: () => {
      for (const key of [
        ['client', clientId],
        ['client-advocacy-matters', clientId],
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      void run.refetch();
    },
  });

  const proposals = useMemo(
    () => (current?.findings ?? []).filter((finding) => finding.status === 'pending'),
    [current],
  );

  /** Informational PE / LDA / bill context — shown even when nothing is applyable. */
  const contextFindings = useMemo(
    () => (current?.findings ?? []).filter((finding) => finding.status === 'informational'),
    [current],
  );

  const rejectedFindings = useMemo(
    () => (current?.findings ?? []).filter((finding) => finding.status === 'rejected'),
    [current],
  );

  /** Sources that reported a failure — drives the partial-source message. */
  const failedSources = useMemo(() => {
    const states = current?.sourceStates ?? {};
    return Object.entries(states)
      .filter(([, state]) => {
        const value = state as { status?: string } | string | null;
        const status = typeof value === 'string' ? value : value?.status;
        return status === 'failed' || status === 'error' || status === 'unavailable';
      })
      .map(([name]) => name);
  }, [current]);

  const phase: FillPhase = useMemo(() => {
    if (
      httpStatus(start.error) === 403 ||
      httpStatus(apply.error) === 403 ||
      httpStatus(reject.error) === 403 ||
      httpStatus(restore.error) === 403
    ) return 'permission-denied';
    if (apply.isPending) return 'applying';
    if (applyOutcome) return applyOutcome.failed > 0 ? 'apply-partial' : 'applied';
    if (start.isPending) return 'preparing';
    if (start.error && !current) return 'failed';
    if (!current) return latest.isLoading ? 'preparing' : 'idle';
    if (current.status === 'running') return 'researching';
    if (current.status === 'failed') return 'failed';
    if (current.status === 'cancelled') return 'cancelled';
    if (proposals.length === 0 && contextFindings.length === 0) return 'no-changes';
    if (proposals.length === 0 && contextFindings.length > 0) return 'context-only';
    if (current.status === 'partial' || failedSources.length > 0) return 'partial';
    return 'proposals';
  }, [start, apply, reject.error, restore.error, applyOutcome, current, latest.isLoading, proposals.length, contextFindings.length, failedSources.length]);

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback(
    (on: boolean) => setSelected(on ? new Set(proposals.map((finding) => finding.id)) : new Set()),
    [proposals],
  );

  const setSelectedFinding = useCallback((id: string, on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const setSelectedFindings = useCallback((ids: string[]) => {
    setSelected(new Set(ids));
  }, []);

  // A successful apply or assignment can settle findings while their local
  // selection IDs remain. Only still-pending proposals can be applied again.
  const pendingIds = new Set(proposals.map((finding) => finding.id));
  const pendingSelected = new Set([...selected].filter((id) => pendingIds.has(id)));

  return {
    phase,
    run: current,
    proposals,
    contextFindings,
    rejectedFindings,
    failedSources,
    selected: pendingSelected,
    toggle,
    setAll,
    setSelectedFinding,
    setSelectedFindings,
    applyOutcome,
    startError: start.error,
    applyError: apply.error,
    start: (input?: { sources?: string[]; website?: string } | string[]) => {
      if (Array.isArray(input)) {
        start.mutate({ sources: input });
        return;
      }
      start.mutate({ sources: input?.sources, website: input?.website });
    },
    startForAttachment: (attachmentId: string) => start.mutate({ attachmentId }),
    cancelRun: () => cancel.mutate(),
    cancelPending: cancel.isPending,
    cancelError: cancel.error,
    retryTask: (taskId: string) => retryTask.mutate(taskId),
    retryTaskPending: retryTask.isPending,
    retryTaskError: retryTask.error,
    applySelected: () => apply.mutate([...pendingSelected]),
    applyAll: () => apply.mutate(proposals.map((finding) => finding.id)),
    /** §22/23 "Not advocacy" — rejects a still-pending finding so it is
     *  never written as a client_advocacy_record row. `reason` is stored
     *  server-side for the audit trail; the UI supplies a fixed default
     *  when the reviewer didn't type one. */
    rejectFinding: (findingId: string, reason?: string) => reject.mutate({ findingId, reason }),
    rejectError: reject.error,
    restoreFinding: (findingId: string) => restore.mutate(findingId),
    restorePending: restore.isPending,
    restoreError: restore.error,
    /** §22/23 follow-up: "Attach to Matter X" / "Create new Matter" on a
     *  pending advocacy finding. Returns a promise (unlike the other
     *  fire-and-forget mutators here) so the caller can await the real
     *  server outcome — needed to open the drawer/tab on the exact Matter
     *  id the server resolved to (especially for "Create new Matter",
     *  where that id does not exist client-side until the response
     *  arrives) and to know definitively whether it failed, for the
     *  optimistic-UI rollback the UI applies around this call. */
    assignFindingMatter: (
      findingId: string,
      target: { matterId: string } | { newMatter: { title: string; matterType?: string; summary?: string | null } },
    ) => assignMatter.mutateAsync({ findingId, target }),
    assignMatterPending: assignMatter.isPending,
    assignMatterError: assignMatter.error,
    reset: () => {
      setRunId(null);
      setSelected(new Set());
      setApplyOutcome(null);
    },
  };
}
