/**
 * LegiWatch V2 Wave 2 — web data hooks for Watch Presets + backtest (W2-4)
 * and watchlist coverage (W2-5).
 *
 * Same conventions as wave1-api.ts: real endpoints only, no mock data, and no
 * client-side fallback that invents a value the server did not return.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { w1Error } from './wave1-api.js';

export { w1Error as w2Error };

const BASE = '/api/legiwatch/live-hearings';
const enc = encodeURIComponent;

// ── W2-4 · Watch Presets + backtest ─────────────────────────────────────

export const SIGNAL_FAMILIES = [
  'bill',
  'hearing',
  'regulation',
  'program_element',
  'state_bill',
] as const;
export type SignalFamily = (typeof SIGNAL_FAMILIES)[number];

export const SIGNAL_FAMILY_LABEL: Record<SignalFamily, string> = {
  bill: 'Bills',
  hearing: 'Hearings',
  regulation: 'Regulations',
  program_element: 'Program elements',
  state_bill: 'State bills',
};

export const CONDITION_TYPES = [
  'KEYWORD_MATCH',
  'STATUS_CHANGE',
  'FUNDING_MOVEMENT',
  'HEARING_SCHEDULED',
  'CLIENT_RELEVANCE_HIGH',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const CONDITION_LABEL: Record<ConditionType, string> = {
  KEYWORD_MATCH: 'Keyword match',
  STATUS_CHANGE: 'Status change',
  FUNDING_MOVEMENT: 'Funding movement',
  HEARING_SCHEDULED: 'Hearing scheduled',
  CLIENT_RELEVANCE_HIGH: 'High client relevance',
};

export interface WatchCondition {
  type: ConditionType;
  family?: SignalFamily;
  keyword?: string;
  committeeSystemCode?: string;
  minMaterialityScore?: number;
}

export interface WatchPreset {
  id: string;
  name: string;
  clientIds: string[];
  signalFamilies: SignalFamily[];
  conditions: WatchCondition[];
  status: 'active' | 'paused' | 'archived';
  createdAt: string;
  updatedAt: string;
}

export interface BacktestSampleMatch {
  packetId: string;
  canonicalObject: { kind: SignalFamily; id: string; label: string; detailPath: string | null };
  occurredAt: string;
  reasonCodes: string[];
  matchedConditions: string[];
  evidence: string | null;
}

export interface BacktestResult {
  evaluatedFrom: string;
  evaluatedTo: string;
  corpusCoverage: Record<SignalFamily, { evaluated: boolean }>;
  totalMatched: number;
  bySignalFamily: Record<string, number>;
  byPriority: Record<string, number>;
  sampleMatches: BacktestSampleMatch[];
  unknownOrUnsupportedConditions: Array<{ condition: WatchCondition; reason: string }>;
  queryVersion: string;
  asOf: string;
}

export interface BacktestJob {
  id: string;
  status: 'pending' | 'leased' | 'completed' | 'failed';
  result: BacktestResult | null;
  lastError: string | null;
  queryVersion: string;
  createdAt: string;
  completedAt: string | null;
}

export function useWatchPresets(): UseQueryResult<{ rows: WatchPreset[] }, Error> {
  const api = useApi();
  return useQuery<{ rows: WatchPreset[] }, Error>({
    queryKey: ['lw-w2', 'watch-presets'],
    queryFn: async () => (await api.get<{ rows: WatchPreset[] }>(`${BASE}/watch-presets`)).data,
    staleTime: 30_000,
    retry: false,
  });
}

export function useCreateWatchPreset() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    WatchPreset,
    Error,
    {
      name: string;
      clientIds: string[];
      signalFamilies: SignalFamily[];
      conditions: WatchCondition[];
    }
  >({
    mutationFn: async (input) => (await api.post<WatchPreset>(`${BASE}/watch-presets`, input)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lw-w2', 'watch-presets'] }),
  });
}

export function useSetWatchPresetStatus() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<WatchPreset, Error, { id: string; status: 'active' | 'paused' | 'archived' }>({
    mutationFn: async ({ id, status }) =>
      (await api.put<WatchPreset>(`${BASE}/watch-presets/${enc(id)}/status`, { status })).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lw-w2', 'watch-presets'] }),
  });
}

export function useUpdateWatchPreset() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    WatchPreset,
    Error,
    {
      id: string;
      name?: string;
      clientIds?: string[];
      signalFamilies?: SignalFamily[];
      conditions?: WatchCondition[];
    }
  >({
    mutationFn: async ({ id, ...body }) =>
      (await api.put<WatchPreset>(`${BASE}/watch-presets/${enc(id)}`, body)).data,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['lw-w2', 'watch-presets'] }),
  });
}

/**
 * Submit a backtest preview. The server attempts to complete it inline (the
 * matcher's queries are all bounded and indexed), so this resolves with a
 * completed result in the common case; `status` still distinguishes it from a
 * job a caller would need to poll.
 */
export function useSubmitBacktest() {
  const api = useApi();
  return useMutation<
    BacktestJob,
    Error,
    {
      presetId?: string;
      clientIds: string[];
      signalFamilies: SignalFamily[];
      conditions: WatchCondition[];
      windowDays?: number;
    }
  >({
    mutationFn: async (input) =>
      (await api.post<BacktestJob>(`${BASE}/watch-presets/backtest`, input)).data,
  });
}

// ── W2-5 · watchlist coverage ────────────────────────────────────────────

export type ConceptStatus = 'COVERED' | 'PARTIAL' | 'UNSUPPORTED' | 'STALE' | 'UNAVAILABLE';
export type OverallCoverageStatus = ConceptStatus | 'NOT_CONFIGURED';

export interface ConceptCoverage {
  conceptId: string;
  label: string;
  signalFamilies: SignalFamily[];
  status: ConceptStatus;
  supportingSources: string[];
  gaps: string[];
  lastObservedAt: string | null;
}

export interface WatchlistCoverage {
  clientId: string;
  asOf: string;
  overall: {
    coveredConcepts: number;
    totalConcepts: number;
    percentage: number | null;
    status: OverallCoverageStatus;
  };
  concepts: ConceptCoverage[];
  signalFamilies: Array<{
    family: SignalFamily;
    configuredConcepts: number;
    coveredConcepts: number;
    status: ConceptStatus;
  }>;
  sourceHealth: {
    healthy: number;
    degraded: number;
    failing: number;
    stale: number;
    acceptedExceptions: number;
  };
  recommendations: string[];
}

export const COVERAGE_STATUS_LABEL: Record<OverallCoverageStatus, string> = {
  COVERED: 'COVERED',
  PARTIAL: 'PARTIAL',
  UNSUPPORTED: 'UNSUPPORTED',
  STALE: 'STALE',
  UNAVAILABLE: 'UNAVAILABLE',
  NOT_CONFIGURED: 'NOT CONFIGURED',
};

export const COVERAGE_STATUS_TONE: Record<
  OverallCoverageStatus,
  'success' | 'warning' | 'gray' | 'error'
> = {
  COVERED: 'success',
  PARTIAL: 'warning',
  UNSUPPORTED: 'gray',
  STALE: 'warning',
  UNAVAILABLE: 'gray',
  NOT_CONFIGURED: 'gray',
};

export function useWatchlistCoverage(clientId: string): UseQueryResult<WatchlistCoverage, Error> {
  const api = useApi();
  return useQuery<WatchlistCoverage, Error>({
    queryKey: ['lw-w2', 'coverage', clientId],
    queryFn: async () =>
      (await api.get<WatchlistCoverage>(`${BASE}/clients/${enc(clientId)}/coverage`)).data,
    enabled: Boolean(clientId),
    staleTime: 60_000,
    retry: false,
  });
}
