import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import {
  getAcquisitionPersonnel,
  getAcquisitionPersonnelDetail,
} from '../../../pages/program-element/api.js';
import type {
  AcquisitionPersonnelDetail,
  AcquisitionPersonnelListItem,
} from '../../../pages/program-element/types.js';
import type { DirectoryFilterOption } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';

/**
 * Department of War controller (DIRECTORY-HANDOFF §7.4).
 *
 * The data half of the acquisition-personnel surface. Owns the list query, the
 * URL as single source of filter state, and shape-guarding of the provenance
 * contract — so the view stays data-free for the visual harness.
 *
 * Two rules are load-bearing and live here, not in the view:
 *  - PE-aligned records sort first. The server does this (`sort: 'pe_first'`);
 *    we never re-sort client-side, which would break the stable server order.
 *  - Provenance is displayed, never invented. `confidence` / `firstSeenAt` /
 *    `lastSeenAt` render only when the source supplied them; an absent field is
 *    an absent line, never a defaulted one (non-negotiable #6).
 */

export const DOW_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

/** Keys the acquisition-personnel endpoint accepts, cleared together on reset. */
const FILTER_KEYS = ['q', 'service', 'role', 'org', 'pe', 'page'] as const;

const PE_ALIGNMENT_OPTIONS: readonly DirectoryFilterOption[] = [
  { value: 'aligned', label: 'PE-aligned' },
  { value: 'unaligned', label: 'Unaligned' },
];

export interface DowDetailModel {
  isLoading: boolean;
  isError: boolean;
  detail: AcquisitionPersonnelDetail | null;
  onRetry: () => void;
}

export interface DowModel {
  search: { text: string; onChange: (next: string) => void };
  filters: {
    pe: string[];
    service: string[];
    role: string[];
    org: string[];
    peOptions: readonly DirectoryFilterOption[];
    serviceOptions: DirectoryFilterOption[];
    roleOptions: DirectoryFilterOption[];
    orgOptions: DirectoryFilterOption[];
    hasAny: boolean;
    onChange: (key: string, values: string[]) => void;
    onClearAll: () => void;
  };
  results: {
    persons: AcquisitionPersonnelListItem[];
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
    selected: AcquisitionPersonnelListItem | null;
    onToggle: (id: string) => void;
    onOpenProfile: (id: string) => void;
    detail: DowDetailModel;
  };
}

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw ? raw.split(',').filter(Boolean) : [];
}

/** First non-empty value of a single-select filter list, for the API param. */
function single(values: string[]): string | undefined {
  return values.length === 1 ? values[0] : undefined;
}

export function useDowModel(): DowModel {
  const api = useApi();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const query = searchParams.get('q') ?? '';
  const pe = readList(searchParams, 'pe');
  const service = readList(searchParams, 'service');
  const role = readList(searchParams, 'role');
  const org = readList(searchParams, 'org');
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

  const listQuery = useQuery({
    queryKey: ['dow-directory', query, page, service, role, org, pe],
    queryFn: () =>
      getAcquisitionPersonnel(api, {
        q: query || undefined,
        service: single(service),
        role: single(role),
        organization: single(org),
        // pe_aligned is the only value the API accepts for the PE dimension;
        // a specific pe_code is a separate param we don't surface as a pill.
        pe_aligned: single(pe) as 'aligned' | 'unaligned' | undefined,
        sort: 'pe_first',
        page,
        limit: DOW_PAGE_SIZE,
      }),
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const persons = listQuery.data?.data ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / DOW_PAGE_SIZE));
  const selected = selectedId ? persons.find((p) => p.id === selectedId) ?? null : null;

  // Filter options derive from the current result set's distinct values. The
  // endpoint has no facet route; distinct-from-page is honest (a value only
  // appears if it exists in the data) and never fabricates an option.
  const serviceOptions = useMemo<DirectoryFilterOption[]>(
    () =>
      Array.from(new Set(persons.map((p) => p.service).filter((v): v is string => Boolean(v))))
        .sort()
        .map((value) => ({ value, label: value })),
    [persons],
  );
  const roleOptions = useMemo<DirectoryFilterOption[]>(
    () =>
      Array.from(new Set(persons.map((p) => p.role).filter((v): v is string => Boolean(v))))
        .sort()
        .map((value) => ({ value, label: value })),
    [persons],
  );
  const orgOptions = useMemo<DirectoryFilterOption[]>(
    () =>
      Array.from(new Set(persons.map((p) => p.organization).filter((v): v is string => Boolean(v))))
        .sort()
        .map((value) => ({ value, label: value })),
    [persons],
  );

  // Provenance + full source mentions live on the detail contract; fetched for
  // the selected person only.
  const detailQuery = useQuery({
    queryKey: ['dow-person', selectedId],
    queryFn: () => getAcquisitionPersonnelDetail(api, selectedId as string),
    enabled: Boolean(selectedId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return {
    search: { text: searchText, onChange: setSearchText },
    filters: {
      pe,
      service,
      role,
      org,
      peOptions: PE_ALIGNMENT_OPTIONS,
      serviceOptions,
      roleOptions,
      orgOptions,
      hasAny:
        Boolean(query) || pe.length > 0 || service.length > 0 || role.length > 0 || org.length > 0,
      onChange: setFilter,
      onClearAll: clearAll,
    },
    results: {
      persons,
      total,
      isInitialLoading: listQuery.isLoading && !listQuery.data,
      isRefetching: listQuery.isFetching && Boolean(listQuery.data),
      isError: listQuery.isError,
      onRetry: () => void listQuery.refetch(),
    },
    pagination: {
      page,
      totalPages,
      pageSize: DOW_PAGE_SIZE,
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
      onOpenProfile: (id) => navigate(DIRECTORY_PROFILE_ROUTES.departmentOfWarPerson(id)),
      detail: {
        isLoading: detailQuery.isLoading,
        isError: detailQuery.isError,
        detail: detailQuery.data ?? null,
        onRetry: () => void detailQuery.refetch(),
      },
    },
  };
}
