import { useQueries } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { latestDataUpdatedAt, relativeRefresh } from '../../adapters/legacy/useClientCrmOverviewModel.js';
import type { Client } from '../../../pages/clients/clientTypes.js';

/**
 * One read of "is this client's profile actually populated, and how fresh is
 * what we are showing" — shared by the breadcrumb's freshness label and gap
 * chip (wire-audit "3 Compose extend" items 11-12) and by the Data health
 * drawer that shows the per-source detail.
 *
 * Every query key here is one an actual tab already uses, so mounting this in
 * the shell costs no extra requests: react-query dedupes against the tab's own
 * fetch and both read the same cache entry.
 *
 * The three states are the product-wide invariant this drawer already stated:
 *
 *   OK          the source answered and returned records
 *   EMPTY       the source answered and has nothing — a real, trustworthy zero
 *   UNAVAILABLE the source failed, which is NOT zero and never renders as one
 */

export type SourceState = 'loading' | 'ok' | 'empty' | 'unavailable';

export interface DataHealthSource {
  key: string;
  label: string;
  queryKey: readonly unknown[];
  path: string;
  params?: Record<string, unknown>;
}

export function dataHealthSources(clientId: string): DataHealthSource[] {
  return [
    { key: 'people', label: 'Contacts', queryKey: ['client-people', clientId], path: `/api/clients/${clientId}/people` },
    {
      key: 'capabilities',
      label: 'Capabilities',
      queryKey: ['client-capabilities', clientId],
      path: `/api/clients/${clientId}/capabilities`,
    },
    {
      key: 'facilities',
      label: 'Facilities',
      queryKey: ['client-facilities', clientId],
      path: `/api/clients/${clientId}/facilities`,
    },
    {
      key: 'files',
      label: 'Files',
      queryKey: ['client-attachments', clientId],
      path: '/api/engagement/attachments',
      params: { clientId },
    },
    {
      key: 'activity',
      label: 'Relationship history',
      queryKey: ['client-activity', clientId],
      path: `/api/clients/${clientId}/activity`,
    },
    {
      key: 'kb',
      label: 'Knowledge base index',
      queryKey: ['client-kb-status', clientId],
      path: `/api/clio/kb/${clientId}/status`,
    },
  ];
}

export interface DataHealthRow {
  source: DataHealthSource;
  state: SourceState;
  count: number;
  error: unknown;
  refetch: () => void;
}

export interface ClientDataHealth {
  rows: DataHealthRow[];
  /**
   * Sources that answered and hold nothing — the gaps in the profile. A source
   * that FAILED is deliberately not counted: we do not know whether it is a
   * gap, and calling an outage a gap sends the user to fill in data that may
   * already be there.
   */
  gaps: number;
  /** Sources that could not be read at all. */
  failures: number;
  /** True once every source has settled, so a count means something. */
  settled: boolean;
  /**
   * How fresh the data on screen is: the most recent successful fetch across
   * these sources, phrased the way `useClientCrmOverviewModel` already phrases
   * its own `lastRefresh`. Null until something has loaded.
   *
   * This is honestly a CLIENT-side fetch time, not a server-side ingestion
   * time. No per-client ingestion timestamp exists to read — the intelligence
   * profile's `lastUpdated` is stamped `new Date()` as the response is built,
   * so it always reads "just now" and says nothing about the data's age.
   */
  refreshedLabel: string | null;
  refetchAll: () => void;
}

export function useClientDataHealth(client: Client): ClientDataHealth {
  const api = useApi();
  const sources = dataHealthSources(client.id);

  const results = useQueries({
    queries: sources.map((source) => ({
      queryKey: source.queryKey,
      queryFn: async () =>
        (
          await api.get<unknown>(source.path, {
            ...((source.params ? { params: source.params } : {}) as Record<string, unknown>),
          })
        ).data,
      retry: false,
      staleTime: 60_000,
    })),
  });

  const rows: DataHealthRow[] = sources.map((source, index) => {
    const result = results[index];
    const state: SourceState = !result || result.isLoading
      ? 'loading'
      : result.isError
        ? 'unavailable'
        : countOf(result.data) === 0
          ? 'empty'
          : 'ok';
    return {
      source,
      state,
      count: countOf(result?.data),
      error: result?.error,
      refetch: () => void result?.refetch(),
    };
  });

  const refreshedAt = latestDataUpdatedAt(...results.map((result) => ({ dataUpdatedAt: result.dataUpdatedAt })));

  return {
    rows,
    gaps: rows.filter((row) => row.state === 'empty').length,
    failures: rows.filter((row) => row.state === 'unavailable').length,
    settled: rows.every((row) => row.state !== 'loading'),
    refreshedLabel: refreshedAt == null ? null : relativeRefresh(refreshedAt),
    refetchAll: () => rows.forEach((row) => row.refetch()),
  };
}

/** Records in a payload, whatever shape the source returns. */
export function countOf(data: unknown): number {
  if (Array.isArray(data)) return data.length;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (Array.isArray(record.data)) return record.data.length;
    if (record.counts && typeof record.counts === 'object') {
      return Object.values(record.counts as Record<string, number>).reduce(
        (sum, value) => sum + (value ?? 0),
        0,
      );
    }
  }
  return 0;
}
