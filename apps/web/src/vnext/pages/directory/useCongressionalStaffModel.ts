import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getStaffDetail } from '../../../pages/directory/directory-api.js';
import type {
  DirectoryApiResponse,
  DirectoryStaffer,
  DirectoryStaffersResponse,
} from '../../../pages/directory/directoryData.js';
import type { DirectoryFilterOption } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';

/**
 * Congressional Staff controller (Figma `937:2539`).
 *
 * This is the data half of the screen. It owns every query, the URL as the
 * single source of filter state, and the shape-guarding of the detail contract
 * — so `CongressionalStaffVNextView` can stay data-free and render inside the
 * Clerk-free visual harness, which issues no API requests at all.
 */

export const CONGRESSIONAL_STAFF_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

export const CHAMBER_OPTIONS: readonly DirectoryFilterOption[] = [
  { value: 'House', label: 'House' },
  { value: 'Senate', label: 'Senate' },
];

/** Keys the canonical endpoint actually accepts, cleared together on reset. */
const FILTER_KEYS = ['q', 'chamber', 'state', 'issue', 'page'] as const;

export interface CongressionalStaffDetailModel {
  isLoading: boolean;
  isError: boolean;
  /** Committee lives on the staff *detail* contract, never on the list row. */
  committeeNames: string | null;
  /** `source` is optional on the payload; absent is the real "missing" state. */
  sourceSnapshotId: string | null;
  onRetry: () => void;
}

export interface CongressionalStaffModel {
  search: {
    text: string;
    onChange: (next: string) => void;
  };
  filters: {
    chamber: string[];
    state: string[];
    issue: string[];
    chamberOptions: readonly DirectoryFilterOption[];
    stateOptions: DirectoryFilterOption[];
    issueOptions: DirectoryFilterOption[];
    hasAny: boolean;
    onChange: (key: string, values: string[]) => void;
    onClearAll: () => void;
  };
  results: {
    staffers: DirectoryStaffer[];
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
    selected: DirectoryStaffer | null;
    onToggle: (id: string) => void;
    onOpenProfile: (id: string) => void;
    detail: CongressionalStaffDetailModel;
  };
}

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw ? raw.split(',').filter(Boolean) : [];
}

export function useCongressionalStaffModel(): CongressionalStaffModel {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const chamber = readList(searchParams, 'chamber');
  const state = readList(searchParams, 'state');
  const issue = readList(searchParams, 'issue');
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const selectedId = searchParams.get('profile');

  // Local mirror so typing stays responsive; the URL is updated on a debounce so
  // a search remains shareable and survives refresh.
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

  const staffersQuery = useQuery({
    queryKey: ['directory-staffers', query, chamber, state, issue, page],
    queryFn: async () =>
      (
        await api.get<DirectoryStaffersResponse>('/api/directory/staffers', {
          params: {
            q: query || undefined,
            chamber: chamber.length === 1 ? chamber[0] : undefined,
            state: state.length ? state : undefined,
            issue: issue.length ? issue.join(',') : undefined,
            page,
            pageSize: CONGRESSIONAL_STAFF_PAGE_SIZE,
          },
        })
      ).data,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  /**
   * `availableFilters` on the canonical contacts response is the filter-value
   * source the legacy Directory already relies on. Only that block is consumed
   * here, so the page size stays minimal.
   */
  const filterValuesQuery = useQuery({
    queryKey: ['directory-available-filters'],
    queryFn: async () =>
      (await api.get<DirectoryApiResponse>('/api/directory/contacts', { params: { page: 1, pageSize: 1 } }))
        .data.availableFilters,
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const stateOptions = useMemo<DirectoryFilterOption[]>(
    () => (filterValuesQuery.data?.states ?? []).map((value: string) => ({ value, label: value })),
    [filterValuesQuery.data],
  );
  const issueOptions = useMemo<DirectoryFilterOption[]>(
    () => (filterValuesQuery.data?.issues ?? []).map((value: string) => ({ value, label: value })),
    [filterValuesQuery.data],
  );

  const staffers = staffersQuery.data?.staffers ?? [];
  const total = staffersQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / CONGRESSIONAL_STAFF_PAGE_SIZE));
  const selected = selectedId ? staffers.find((s) => s.id === selectedId) ?? null : null;

  // The rail's committee + provenance lines live on the staff *detail* contract,
  // not the list row, so they are fetched for the selected person only.
  const detailQuery = useQuery({
    queryKey: ['directory-staff-detail', selectedId],
    queryFn: () => getStaffDetail(api, selectedId as string),
    enabled: Boolean(selectedId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const committeeNames = detailQuery.data?.committeeAssociations?.length
    ? detailQuery.data.committeeAssociations
        .map((association) => association.position ?? association.committeeId)
        .slice(0, 2)
        .join(' · ')
    : null;

  return {
    search: {
      text: searchText,
      onChange: setSearchText,
    },
    filters: {
      chamber,
      state,
      issue,
      chamberOptions: CHAMBER_OPTIONS,
      stateOptions,
      issueOptions,
      hasAny: Boolean(query) || chamber.length > 0 || state.length > 0 || issue.length > 0,
      onChange: setFilter,
      onClearAll: clearAll,
    },
    results: {
      staffers,
      total,
      isInitialLoading: staffersQuery.isLoading && !staffersQuery.data,
      isRefetching: staffersQuery.isFetching && Boolean(staffersQuery.data),
      isError: staffersQuery.isError,
      onRetry: () => void staffersQuery.refetch(),
    },
    pagination: {
      page,
      totalPages,
      pageSize: CONGRESSIONAL_STAFF_PAGE_SIZE,
      onPageChange: (next) => commit((params) => params.set('page', String(next))),
    },
    selection: {
      selectedId,
      selected,
      onToggle: (id) =>
        commit((next) => {
          if (id === selectedId) next.delete('profile');
          else next.set('profile', id);
        }),
      onOpenProfile: (id) => navigate(DIRECTORY_PROFILE_ROUTES.staff(id)),
      detail: {
        isLoading: detailQuery.isLoading,
        isError: detailQuery.isError,
        committeeNames,
        // Guarded with `?.`: a detail payload without `source` is exactly the
        // required "provenance missing" state, and crashed an earlier draft.
        sourceSnapshotId: detailQuery.data?.source?.snapshotId ?? null,
        onRetry: () => void detailQuery.refetch(),
      },
    },
  };
}
