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
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

export type FillRunStatus = 'running' | 'completed' | 'partial' | 'failed';
export type FillFindingStatus = 'pending' | 'accepted' | 'rejected' | 'informational';
export type FillFactKind = 'fact' | 'recommendation';

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
  | 'partial'
  | 'failed'
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
    mutationFn: async (sources?: string[]) =>
      (await api.post<FillRun>(`${base}/runs`, sources?.length ? { sources } : {})).data,
    onSuccess: (created) => {
      setRunId(created.id);
      setSelected(new Set());
      setApplyOutcome(null);
      qc.setQueryData(['client-fill-with-meri', clientId, 'run', created.id], created);
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
      ]) {
        void qc.invalidateQueries({ queryKey: key });
      }
      void qc.invalidateQueries({ queryKey: ['clients'] });
      void run.refetch();
    },
  });

  const proposals = useMemo(
    () => (current?.findings ?? []).filter((finding) => finding.status === 'pending'),
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
    if (httpStatus(start.error) === 403 || httpStatus(apply.error) === 403) return 'permission-denied';
    if (apply.isPending) return 'applying';
    if (applyOutcome) return applyOutcome.failed > 0 ? 'apply-partial' : 'applied';
    if (start.isPending) return 'preparing';
    if (!current) return latest.isLoading ? 'preparing' : 'idle';
    if (current.status === 'running') return 'researching';
    if (current.status === 'failed') return 'failed';
    if (proposals.length === 0) return 'no-changes';
    if (current.status === 'partial' || failedSources.length > 0) return 'partial';
    return 'proposals';
  }, [start, apply, applyOutcome, current, latest.isLoading, proposals.length, failedSources.length]);

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

  return {
    phase,
    run: current,
    proposals,
    failedSources,
    selected,
    toggle,
    setAll,
    applyOutcome,
    startError: start.error,
    applyError: apply.error,
    start: (sources?: string[]) => start.mutate(sources),
    applySelected: () => apply.mutate([...selected]),
    applyAll: () => apply.mutate(proposals.map((finding) => finding.id)),
    reset: () => {
      setRunId(null);
      setSelected(new Set());
      setApplyOutcome(null);
    },
  };
}
