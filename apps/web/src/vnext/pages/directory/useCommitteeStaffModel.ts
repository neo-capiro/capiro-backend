import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  DirectoryCommittee,
  DirectoryCommitteesResponse,
  DirectoryCommitteeStaffResponse,
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';
import type { DirectoryFilterOption } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';

/**
 * Committee Staff controller (DIRECTORY-HANDOFF §7.2/§7.3).
 *
 * Hierarchy and Roster are ONE route with a `?view=` parameter over ONE
 * committee dataset — the handoff's deliberate deviation #2. This hook owns the
 * committee picker, the roster query, the URL as single source of state, and
 * the selection model shared by both views.
 *
 * The roster row and the hierarchy node are the SAME record with the SAME staff
 * id (non-negotiable #3): `/directory/staff/:staffId` is the one canonical
 * profile destination for both committee and congressional staff. There is no
 * committee-specific copy of a staff record.
 */

export const COMMITTEE_STAFF_PAGE_SIZE = 500;
const SEARCH_DEBOUNCE_MS = 300;

const FILTER_KEYS = ['q', 'chamber', 'cmte', 'page'] as const;

const CHAMBER_OPTIONS: readonly DirectoryFilterOption[] = [
  { value: 'House', label: 'House' },
  { value: 'Senate', label: 'Senate' },
  { value: 'Joint', label: 'Joint' },
];

export interface CommitteeStaffModel {
  search: { text: string; onChange: (next: string) => void };
  view: {
    current: 'hierarchy' | 'roster';
    onChange: (next: 'hierarchy' | 'roster') => void;
  };
  committee: {
    selectedId: string | null;
    options: DirectoryFilterOption[];
    committees: DirectoryCommittee[];
    onSelect: (id: string) => void;
    detail: DirectoryCommittee | null;
    isLoadingList: boolean;
  };
  filters: {
    chamber: string[];
    chamberOptions: readonly DirectoryFilterOption[];
    hasAny: boolean;
    onChange: (key: string, values: string[]) => void;
    onClearAll: () => void;
  };
  results: {
    staff: DirectoryCommitteeStaffer[];
    total: number;
    isInitialLoading: boolean;
    isRefetching: boolean;
    isError: boolean;
    onRetry: () => void;
  };
  selection: {
    selectedId: string | null;
    selected: DirectoryCommitteeStaffer | null;
    onToggle: (id: string) => void;
    onOpenProfile: (id: string) => void;
  };
}

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw ? raw.split(',').filter(Boolean) : [];
}

export function useCommitteeStaffModel(): CommitteeStaffModel {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const chamber = readList(searchParams, 'chamber');
  const view: 'hierarchy' | 'roster' = searchParams.get('view') === 'roster' ? 'roster' : 'hierarchy';
  const committeeId = searchParams.get('cmte');
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
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchText, query, commit]);

  const setFilter = useCallback(
    (key: string, values: string[]) => {
      commit((next) => {
        if (values.length) next.set(key, values.join(','));
        else next.delete(key);
      });
    },
    [commit],
  );

  const clearAll = useCallback(() => {
    commit((next) => {
      FILTER_KEYS.forEach((key) => next.delete(key));
    });
  }, [commit]);

  // Committee picker list (federal House/Senate/Joint committees).
  const committeesQuery = useQuery({
    queryKey: ['directory-committees', query, chamber],
    queryFn: async () =>
      (
        await api.get<DirectoryCommitteesResponse>('/api/directory/committees', {
          params: {
            q: query || undefined,
            chamber: chamber.length === 1 ? chamber[0] : undefined,
            page: 1,
            pageSize: 200,
          },
        })
      ).data,
    staleTime: 10 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const committees = useMemo(() => committeesQuery.data?.committees ?? [], [committeesQuery.data]);
  const committeeOptions = useMemo<DirectoryFilterOption[]>(
    () => committees.map((c) => ({ value: c.id, label: c.name })),
    [committees],
  );

  // Default to the first committee so neither view renders an empty canvas.
  const effectiveCommitteeId = committeeId ?? committees[0]?.id ?? null;

  const staffQuery = useQuery({
    queryKey: ['directory-committee-staff', effectiveCommitteeId],
    queryFn: async () =>
      (
        await api.get<DirectoryCommitteeStaffResponse>(
          `/api/directory/committees/${encodeURIComponent(effectiveCommitteeId as string)}/staff`,
          { params: { pageSize: COMMITTEE_STAFF_PAGE_SIZE } },
        )
      ).data,
    enabled: effectiveCommitteeId !== null,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const staff = staffQuery.data?.staff ?? [];
  const total = staffQuery.data?.total ?? 0;
  const committeeDetail = staffQuery.data?.committee ?? null;
  const selected = selectedId ? staff.find((s) => s.id === selectedId) ?? null : null;

  return {
    search: { text: searchText, onChange: setSearchText },
    view: {
      current: view,
      onChange: (next) =>
        commit((params) => {
          if (next === 'roster') params.set('view', 'roster');
          else params.delete('view');
        }),
    },
    committee: {
      selectedId: effectiveCommitteeId,
      options: committeeOptions,
      committees,
      onSelect: (id) =>
        commit((params) => {
          params.set('cmte', id);
          params.delete('selected');
        }),
      detail: committeeDetail,
      isLoadingList: committeesQuery.isLoading && !committeesQuery.data,
    },
    filters: {
      chamber,
      chamberOptions: CHAMBER_OPTIONS,
      hasAny: Boolean(query) || chamber.length > 0,
      onChange: setFilter,
      onClearAll: clearAll,
    },
    results: {
      staff,
      total,
      isInitialLoading: staffQuery.isLoading && !staffQuery.data,
      isRefetching: staffQuery.isFetching && Boolean(staffQuery.data),
      isError: staffQuery.isError,
      onRetry: () => void staffQuery.refetch(),
    },
    selection: {
      selectedId,
      selected,
      onToggle: (id) =>
        commit((next) => {
          if (id === selectedId) next.delete('selected');
          else next.set('selected', id);
        }),
      // One canonical staff identity — the same profile route as congressional.
      onOpenProfile: (id) => navigate(DIRECTORY_PROFILE_ROUTES.staff(id)),
    },
  };
}
