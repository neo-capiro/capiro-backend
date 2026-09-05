/**
 * LegiWatch V2 Wave 3 — web data hooks for Digest (generation/history/
 * schedule) and Analytics (aggregate panels). Same conventions as
 * wave1-api.ts/wave2-api.ts: real endpoints only, no mock data, no
 * client-side fallback that invents a value the server did not return.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';

const BASE = '/api/legiwatch/live-hearings';

function qs(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ── Digest ───────────────────────────────────────────────────────────────

export interface DigestWhatChanged {
  id: string;
  title: string;
  band: string;
  sourceLabel: string;
  clientName: string | null;
  ageHours: number;
}
export interface DigestDecision { id: string; title: string; recommendedAction: string | null }
export interface DigestHearing { id: string; title: string; date: string; committeeName: string | null }
export interface DigestBillMovement { id: string; display: string; status: string | null; statusAt: string | null }
export interface DigestClientImplication { clientId: string; clientName: string; band: string }
export interface DigestContent {
  id: string;
  generatedAt: string;
  scopeLabel: string;
  clientsInScope: number;
  headline: string;
  whatChanged: DigestWhatChanged[];
  decisionsRequired: DigestDecision[];
  upcomingHearings: DigestHearing[];
  billMovement: DigestBillMovement[];
  clientImplications: DigestClientImplication[];
  recommendedActions: string[];
  provenance: { sourceFamilies: string[]; officialRecordCount: number; captureCount: number };
}
export interface DigestHistoryRow {
  id: string;
  generatedAt: string;
  itemCount: number;
  decisionCount: number;
  sourceFamilies: string[];
}
export interface DigestSchedule {
  cadence: 'daily' | 'weekly' | 'off';
  hourUtc: number;
  emailEnabled: boolean;
  updatedAt: string | null;
}

export function useGenerateDigest(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<DigestContent, Error, void>({
    mutationFn: async () => (await api.post<DigestContent>(`${BASE}/digest/generate${qs({ clientId })}`, {})).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lw-vnext', 'digest-history', clientId] });
    },
  });
}

export function useDigestHistory(clientId: string): UseQueryResult<{ rows: DigestHistoryRow[] }, Error> {
  const api = useApi();
  return useQuery<{ rows: DigestHistoryRow[] }, Error>({
    queryKey: ['lw-vnext', 'digest-history', clientId],
    queryFn: async () => (await api.get<{ rows: DigestHistoryRow[] }>(`${BASE}/digest/history${qs({ clientId })}`)).data,
    staleTime: 30_000,
  });
}

export function useDigestRun(id: string | null): UseQueryResult<DigestContent, Error> {
  const api = useApi();
  return useQuery<DigestContent, Error>({
    queryKey: ['lw-vnext', 'digest-run', id],
    queryFn: async () => (await api.get<DigestContent>(`${BASE}/digest/${encodeURIComponent(id ?? '')}`)).data,
    enabled: Boolean(id),
  });
}

export function useDigestSchedule(clientId: string): UseQueryResult<DigestSchedule, Error> {
  const api = useApi();
  return useQuery<DigestSchedule, Error>({
    queryKey: ['lw-vnext', 'digest-schedule', clientId],
    queryFn: async () => (await api.get<DigestSchedule>(`${BASE}/digest/schedule/config${qs({ clientId })}`)).data,
    staleTime: 30_000,
  });
}

export function usePutDigestSchedule(clientId: string) {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<DigestSchedule, Error, { cadence: 'daily' | 'weekly' | 'off'; hourUtc: number; emailEnabled: boolean }>({
    mutationFn: async (input) =>
      (await api.put<DigestSchedule>(`${BASE}/digest/schedule/config${qs({ clientId })}`, input)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['lw-vnext', 'digest-schedule', clientId] });
    },
  });
}

// ── Analytics ────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  signalsTotal: number;
  sourceFamiliesInvolved: number;
  clientDecisions: number;
  billsMoved: number;
  billsTrackedTotal: number;
  sourceCoveragePct: number | null;
  sourceFamiliesCurrent: number;
  sourceFamiliesTotal: number;
  from: string;
  to: string;
  freshnessAt: string;
}
export interface SignalVolume { from: string; to: string; total: number; days: Array<{ date: string; count: number }> }
export interface IssueMomentum { from: string; to: string; topics: Array<{ topicId: string; label: string; index: number }> }
export interface ClientExposureRow { clientId: string; clientName: string; monitored: boolean; bySourceFamily: Record<string, number> | null }
export interface ClientExposure { from: string; to: string; rows: ClientExposureRow[] }
export interface CommitteeActivity {
  from: string; to: string; total: number;
  rows: Array<{ systemCode: string | null; committeeName: string | null; count: number }>;
}
export interface SourceCoverage {
  freshnessAt: string;
  sources: Array<{ family: string; coveragePct: number | null; total: number; lastSyncedAt: string | null }>;
}

export function useAnalyticsSummary(clientId: string): UseQueryResult<AnalyticsSummary, Error> {
  const api = useApi();
  return useQuery<AnalyticsSummary, Error>({
    queryKey: ['lw-vnext', 'analytics-summary', clientId],
    queryFn: async () => (await api.get<AnalyticsSummary>(`${BASE}/analytics/summary${qs({ clientId })}`)).data,
    staleTime: 60_000,
  });
}

export function useAnalyticsSignalVolume(clientId: string): UseQueryResult<SignalVolume, Error> {
  const api = useApi();
  return useQuery<SignalVolume, Error>({
    queryKey: ['lw-vnext', 'analytics-signal-volume', clientId],
    queryFn: async () => (await api.get<SignalVolume>(`${BASE}/analytics/signal-volume${qs({ clientId })}`)).data,
    staleTime: 60_000,
  });
}

export function useAnalyticsIssueMomentum(clientId: string): UseQueryResult<IssueMomentum, Error> {
  const api = useApi();
  return useQuery<IssueMomentum, Error>({
    queryKey: ['lw-vnext', 'analytics-issue-momentum', clientId],
    queryFn: async () => (await api.get<IssueMomentum>(`${BASE}/analytics/issue-momentum${qs({ clientId })}`)).data,
    staleTime: 60_000,
  });
}

export function useAnalyticsClientExposure(): UseQueryResult<ClientExposure, Error> {
  const api = useApi();
  return useQuery<ClientExposure, Error>({
    queryKey: ['lw-vnext', 'analytics-client-exposure'],
    queryFn: async () => (await api.get<ClientExposure>(`${BASE}/analytics/client-exposure`)).data,
    staleTime: 60_000,
  });
}

export function useAnalyticsCommitteeActivity(clientId: string): UseQueryResult<CommitteeActivity, Error> {
  const api = useApi();
  return useQuery<CommitteeActivity, Error>({
    queryKey: ['lw-vnext', 'analytics-committee-activity', clientId],
    queryFn: async () => (await api.get<CommitteeActivity>(`${BASE}/analytics/committee-activity${qs({ clientId })}`)).data,
    staleTime: 60_000,
  });
}

export function useAnalyticsSourceCoverage(): UseQueryResult<SourceCoverage, Error> {
  const api = useApi();
  return useQuery<SourceCoverage, Error>({
    queryKey: ['lw-vnext', 'analytics-source-coverage'],
    queryFn: async () => (await api.get<SourceCoverage>(`${BASE}/analytics/source-coverage`)).data,
    staleTime: 5 * 60_000,
  });
}
