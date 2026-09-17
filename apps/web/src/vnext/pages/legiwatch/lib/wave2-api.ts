/**
 * LegiWatch V2 Wave 2 — web data hook for watchlist coverage (W2-5).
 *
 * Same conventions as wave1-api.ts: real endpoints only, no mock data, and no
 * client-side fallback that invents a value the server did not return.
 *
 * W2-4 (Watch Presets + backtest) was removed; its hooks and types are gone.
 * The coverage types reuse the Feed's OWN `FeedSourceType` vocabulary — there
 * is no second family taxonomy.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { FeedSourceType } from './types.js';

const BASE = '/api/legiwatch/live-hearings';
const enc = encodeURIComponent;

// ── W2-5 · watchlist coverage ────────────────────────────────────────────

/** The source families coverage can report: the Feed's own vocabulary minus
 * its `combined` aggregate — exactly the set the coverage service returns. */
export type CoverageSignalFamily = Exclude<FeedSourceType, 'combined'>;

export type ConceptStatus = 'COVERED' | 'PARTIAL' | 'UNSUPPORTED' | 'STALE' | 'UNAVAILABLE';
export type OverallCoverageStatus = ConceptStatus | 'NOT_CONFIGURED';

export interface ConceptCoverage {
  conceptId: string;
  label: string;
  signalFamilies: CoverageSignalFamily[];
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
    family: CoverageSignalFamily;
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
