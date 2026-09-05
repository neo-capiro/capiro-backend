/**
 * LegiWatch V2 Wave 2 — web data hooks for Saved Views (W2-2), Watch Presets +
 * backtest (W2-4), and watchlist coverage (W2-5).
 *
 * Same conventions as wave1-api.ts: real endpoints only, no mock data, and no
 * client-side fallback that invents a value the server did not return.
 */
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { w1Error } from './wave1-api.js';

export { w1Error as w2Error };

const BASE = '/api/legiwatch/live-hearings';
const enc = encodeURIComponent;

// ── W2-2 · Saved Views ───────────────────────────────────────────────────

export type SavedViewSurface =
  | 'hearings_schedule'
  | 'hearings_archive'
  | 'committees'
  | 'committee_intelligence'
  | 'feed'
  | 'bills';

/** The captured URL for a surface — restoring it is a real navigation. */
export interface CapturedViewState {
  pathname: string;
  params: Record<string, string>;
}

export interface SavedView {
  id: string;
  surface: SavedViewSurface;
  name: string;
  scope: 'personal' | 'tenant';
  isDefault: boolean;
  clientId: string | null;
  configVersion: number;
  config: { filters?: CapturedViewState; [key: string]: unknown };
  ownerUserId: string;
  isOwnedByCaller: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppliedSavedView extends SavedView {
  /** Set when the referenced client is archived/deleted — never a silent substitution. */
  clientWarning: string | null;
}

const savedViewKeys = {
  list: (surface?: string, scope?: string) => ['lw-w2', 'saved-views', surface ?? '_all', scope ?? '_all'] as const,
};

export function useSavedViews(
  params: { surface?: SavedViewSurface; scope?: 'personal' | 'tenant' | 'all' } = {},
): UseQueryResult<{ rows: SavedView[] }, Error> {
  const api = useApi();
  return useQuery<{ rows: SavedView[] }, Error>({
    queryKey: savedViewKeys.list(params.surface, params.scope),
    queryFn: async () => {
      const qs = new URLSearchParams();
      if (params.surface) qs.set('surface', params.surface);
      if (params.scope) qs.set('scope', params.scope);
      return (await api.get<{ rows: SavedView[] }>(`${BASE}/saved-views?${qs.toString()}`)).data;
    },
    staleTime: 30_000,
    retry: false,
  });
}

function invalidateSavedViews(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ['lw-w2', 'saved-views'] });
}

export function useCreateSavedView() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    SavedView,
    Error,
    {
      surface: SavedViewSurface;
      name: string;
      scope?: 'personal' | 'tenant';
      clientId?: string;
      config?: Record<string, unknown>;
    }
  >({
    mutationFn: async (input) => (await api.post<SavedView>(`${BASE}/saved-views`, input)).data,
    onSuccess: () => invalidateSavedViews(qc),
  });
}

export function useUpdateSavedView() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<
    SavedView,
    Error,
    { id: string; name?: string; scope?: 'personal' | 'tenant'; clientId?: string; config?: Record<string, unknown> }
  >({
    mutationFn: async ({ id, ...body }) => (await api.put<SavedView>(`${BASE}/saved-views/${enc(id)}`, body)).data,
    onSuccess: () => invalidateSavedViews(qc),
  });
}

export function useDuplicateSavedView() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<SavedView, Error, { id: string; name?: string }>({
    mutationFn: async ({ id, name }) =>
      (await api.post<SavedView>(`${BASE}/saved-views/${enc(id)}/duplicate`, { name })).data,
    onSuccess: () => invalidateSavedViews(qc),
  });
}

export function useSetDefaultSavedView() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<SavedView, Error, { id: string; isDefault: boolean }>({
    mutationFn: async ({ id, isDefault }) =>
      (await api.put<SavedView>(`${BASE}/saved-views/${enc(id)}/default`, { isDefault })).data,
    onSuccess: () => invalidateSavedViews(qc),
  });
}

export function useApplySavedView() {
  const api = useApi();
  return useMutation<AppliedSavedView, Error, { id: string }>({
    mutationFn: async ({ id }) =>
      (await api.post<AppliedSavedView>(`${BASE}/saved-views/${enc(id)}/apply`, {})).data,
  });
}

export function useDeleteSavedView() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation<{ deleted: boolean }, Error, { id: string }>({
    mutationFn: async ({ id }) => (await api.delete<{ deleted: boolean }>(`${BASE}/saved-views/${enc(id)}`)).data,
    onSuccess: () => invalidateSavedViews(qc),
  });
}

/** Capture the CURRENT URL as a saved view's restorable state. */
export function captureCurrentViewState(): CapturedViewState {
  return {
    pathname: window.location.pathname,
    params: Object.fromEntries(new URLSearchParams(window.location.search).entries()),
  };
}

/** The URL a saved view's captured state resolves to. */
export function urlForViewState(state: CapturedViewState): string {
  const qs = new URLSearchParams(state.params).toString();
  return qs ? `${state.pathname}?${qs}` : state.pathname;
}

/** Which surface the CURRENT URL belongs to, for defaulting the picker. */
export function currentSurface(pathname: string, searchParams: URLSearchParams): SavedViewSurface {
  if (/^\/legiwatch\/committees\/[^/]+/.test(pathname)) return 'committee_intelligence';
  if (pathname.startsWith('/legiwatch/hearings/')) return 'hearings_schedule';
  const tab = searchParams.get('tab');
  if (tab === 'committees') return 'committees';
  if (tab === 'feed') return 'feed';
  if (tab === 'bills') return 'bills';
  return searchParams.get('sub') === 'archive' ? 'hearings_archive' : 'hearings_schedule';
}

export const SAVED_VIEW_SURFACE_LABEL: Record<SavedViewSurface, string> = {
  hearings_schedule: 'Hearings — Schedule',
  hearings_archive: 'Hearings — Archive',
  committees: 'Committees',
  committee_intelligence: 'Committee Intelligence',
  feed: 'Feed',
  bills: 'Bills',
};

// ── W2-4 · Watch Presets + backtest ─────────────────────────────────────

export const SIGNAL_FAMILIES = ['bill', 'hearing', 'regulation', 'program_element', 'state_bill'] as const;
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
    { name: string; clientIds: string[]; signalFamilies: SignalFamily[]; conditions: WatchCondition[] }
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
    { id: string; name?: string; clientIds?: string[]; signalFamilies?: SignalFamily[]; conditions?: WatchCondition[] }
  >({
    mutationFn: async ({ id, ...body }) => (await api.put<WatchPreset>(`${BASE}/watch-presets/${enc(id)}`, body)).data,
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

export const COVERAGE_STATUS_TONE: Record<OverallCoverageStatus, 'success' | 'warning' | 'gray' | 'error'> = {
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
