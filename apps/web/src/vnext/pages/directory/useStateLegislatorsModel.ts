import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  StateLegislatorDetail,
  StateLegislatorFacets,
  StateLegislatorRow,
} from '../../../pages/directory/StateLegislatorDirectory.js';
import type { DirectoryFilterOption } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';

/**
 * State Legislators controller (DIRECTORY-HANDOFF §7.5).
 *
 * The data half of the statehouse surface. The one rule that must survive here
 * is unknown-vs-zero: `billCount` / `enactedCount` are `null` (never
 * crosswalked to LegiScan) vs a real number vs `0`. That tri-state comes
 * straight from the API; there is deliberately no `?? 0` anywhere in this
 * module — a default would fabricate a "sponsors nothing" claim for a
 * legislator we simply haven't ingested.
 */

export const STATE_LEG_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

const FILTER_KEYS = ['q', 'state', 'chamber', 'party', 'page'] as const;

export interface StateLegDetailModel {
  isLoading: boolean;
  isError: boolean;
  detail: StateLegislatorDetail | null;
  onRetry: () => void;
}

export interface StateLegModel {
  search: { text: string; onChange: (next: string) => void };
  filters: {
    state: string[];
    chamber: string[];
    party: string[];
    stateOptions: DirectoryFilterOption[];
    chamberOptions: DirectoryFilterOption[];
    partyOptions: DirectoryFilterOption[];
    hasAny: boolean;
    onChange: (key: string, values: string[]) => void;
    onClearAll: () => void;
  };
  results: {
    legislators: StateLegislatorRow[];
    total: number;
    isInitialLoading: boolean;
    isRefetching: boolean;
    isError: boolean;
    onRetry: () => void;
  };
  pagination: {
    page: number;
    totalPages: number;
    pageSize: number;
    onPageChange: (next: number) => void;
  };
  selection: {
    selectedId: string | null;
    selected: StateLegislatorRow | null;
    onToggle: (id: string) => void;
    onOpenProfile: (id: string) => void;
    detail: StateLegDetailModel;
  };
}

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw ? raw.split(',').filter(Boolean) : [];
}

export function useStateLegislatorsModel(): StateLegModel {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const state = readList(searchParams, 'state');
  const chamber = readList(searchParams, 'chamber');
  const party = readList(searchParams, 'party');
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const selectedId = searchParams.get('selected');

  const [searchText, setSearchText] = useState(query);
  useEffect(() => setSearchText(query), [query]);

  const commit = useCallback(
    (mutate: (next: URLSearchParams) => void) => {
      const next = new URLSearchParams(searchParams);
      mutate(next);
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  useEffect(() => {
    if (searchText === query) return undefined;
    const handle = window.setTimeout(() => {
      commit((next) => {
        if (searchText) next.set('q', searchText);
        else next.delete('q');
        next.delete('page');
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchText, query, commit]);

  const setFilter = useCallback(
    (key: string, values: string[]) => {
      commit((next) => {
        if (values.length) next.set(key, values.join(','));
        else next.delete(key);
        next.delete('page');
      });
    },
    [commit],
  );

  const clearAll = useCallback(() => {
    commit((next) => {
      FILTER_KEYS.forEach((key) => next.delete(key));
    });
  }, [commit]);

  const facetsQuery = useQuery({
    queryKey: ['state-legislator-facets'],
    queryFn: async () =>
      (await api.get<StateLegislatorFacets>('/api/explorer/state-legislator-facets')).data,
    staleTime: 10 * 60_000,
    retry: 1,
  });

  const listQuery = useQuery({
    queryKey: ['state-legislators', query, state, chamber, party, page],
    queryFn: async () =>
      (
        await api.get<{ rows: StateLegislatorRow[]; total: number }>(
          '/api/explorer/state-legislators',
          {
            params: {
              q: query || undefined,
              states: state.length ? state.join(',') : undefined,
              chambers: chamber.length ? chamber.join(',') : undefined,
              parties: party.length ? party.join(',') : undefined,
              page,
              pageSize: STATE_LEG_PAGE_SIZE,
            },
          },
        )
      ).data,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const legislators = listQuery.data?.rows ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / STATE_LEG_PAGE_SIZE));
  const selected = selectedId ? legislators.find((l) => l.id === selectedId) ?? null : null;

  const stateOptions = useMemo<DirectoryFilterOption[]>(
    () => (facetsQuery.data?.states ?? []).map((value) => ({ value, label: value })),
    [facetsQuery.data],
  );
  const chamberOptions = useMemo<DirectoryFilterOption[]>(
    () => (facetsQuery.data?.chambers ?? []).map((value) => ({ value, label: value })),
    [facetsQuery.data],
  );
  const partyOptions = useMemo<DirectoryFilterOption[]>(
    () => (facetsQuery.data?.parties ?? []).map((value) => ({ value, label: value })),
    [facetsQuery.data],
  );

  const detailQuery = useQuery({
    queryKey: ['state-legislator-detail', selectedId],
    queryFn: async () =>
      (
        await api.get<StateLegislatorDetail>(
          `/api/explorer/state-legislators/${encodeURIComponent(selectedId as string)}`,
        )
      ).data,
    enabled: Boolean(selectedId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return {
    search: { text: searchText, onChange: setSearchText },
    filters: {
      state,
      chamber,
      party,
      stateOptions,
      chamberOptions,
      partyOptions,
      hasAny: Boolean(query) || state.length > 0 || chamber.length > 0 || party.length > 0,
      onChange: setFilter,
      onClearAll: clearAll,
    },
    results: {
      legislators,
      total,
      isInitialLoading: listQuery.isLoading && !listQuery.data,
      isRefetching: listQuery.isFetching && Boolean(listQuery.data),
      isError: listQuery.isError,
      onRetry: () => void listQuery.refetch(),
    },
    pagination: {
      page,
      totalPages,
      pageSize: STATE_LEG_PAGE_SIZE,
      onPageChange: (next) => commit((params) => params.set('page', String(next))),
    },
    selection: {
      selectedId,
      selected,
      onToggle: (id) =>
        commit((next) => {
          if (id === selectedId) next.delete('selected');
          else next.set('selected', id);
        }),
      onOpenProfile: (id) => navigate(DIRECTORY_PROFILE_ROUTES.stateLegislator(id)),
      detail: {
        isLoading: detailQuery.isLoading,
        isError: detailQuery.isError,
        detail: detailQuery.data ?? null,
        onRetry: () => void detailQuery.refetch(),
      },
    },
  };
}
