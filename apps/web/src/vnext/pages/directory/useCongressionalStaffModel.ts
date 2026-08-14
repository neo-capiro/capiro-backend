import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { getStaffDetail } from '../../../pages/directory/directory-api.js';
import type {
  DirectoryApiResponse,
  DirectoryEntry,
  DirectoryStaffMember,
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
 *
 * **The list is offices, not staffers.** A congressional staffer only exists in
 * relation to the member they work for, so the screen reads member-first and
 * expands to the roster underneath — the same organisation the Outreach
 * recipient picker has always used (`StepRecipientsSelect`'s Congressional
 * Directory tab). That is why the source of truth here is
 * `/api/directory/contacts`, whose rows already carry both the member (with a
 * photo) and their full `staff[]` roster, rather than `/api/directory/staffers`,
 * which is a flattened index with no member rows in it at all.
 */

export const CONGRESSIONAL_STAFF_PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

export const CHAMBER_OPTIONS: readonly DirectoryFilterOption[] = [
  { value: 'House', label: 'House' },
  { value: 'Senate', label: 'Senate' },
];

/** Keys the canonical endpoint actually accepts, cleared together on reset. */
const FILTER_KEYS = ['q', 'chamber', 'state', 'issue', 'role', 'committee', 'page'] as const;

/** One office and the roster the current filters leave visible beneath it. */
export interface CongressionalOfficeRow {
  member: DirectoryEntry;
  /**
   * Roster narrowed by the Role and Issue Area pills. The office qualified
   * because at least one staffer matched, so showing the whole roster would
   * contradict the filter that produced the row.
   */
  staff: DirectoryStaffMember[];
  /** Roster size before narrowing, so a hidden remainder can be stated. */
  staffTotal: number;
  isExpanded: boolean;
}

/**
 * The rail describes whichever identity is selected. Member and staffer are
 * different contracts — a member's committees arrive on the list row while a
 * staffer's only exist on the detail endpoint — so the kind is carried
 * explicitly rather than inferred from which fields happen to be present.
 */
export type CongressionalSelection =
  | { kind: 'member'; id: string; member: DirectoryEntry }
  | { kind: 'staff'; id: string; staff: DirectoryStaffMember; member: DirectoryEntry };

export interface CongressionalStaffDetailModel {
  isLoading: boolean;
  isError: boolean;
  /** Committee lives on the staff *detail* contract, never on the list row. */
  committeeNames: string | null;
  /**
   * A staffer's headshot is nullable and exists only on the detail contract —
   * the list rows carry `photoUrl: null` for staff by design, because a staffer
   * is never shown their member's face. So the rail can offer one and the rows
   * cannot; null here is a real "no photo on file", not a loading gap.
   */
  photoUrl: string | null;
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
    role: string[];
    committee: string[];
    chamberOptions: readonly DirectoryFilterOption[];
    stateOptions: DirectoryFilterOption[];
    issueOptions: DirectoryFilterOption[];
    roleOptions: DirectoryFilterOption[];
    committeeOptions: DirectoryFilterOption[];
    hasAny: boolean;
    onChange: (key: string, values: string[]) => void;
    onClearAll: () => void;
  };
  results: {
    offices: CongressionalOfficeRow[];
    /** Offices matching the filters — what the pagination counts. */
    total: number;
    /** Staff across the whole directory; context, never the paged total. */
    staffTotal: number;
    isInitialLoading: boolean;
    isRefetching: boolean;
    isError: boolean;
    onRetry: () => void;
    onToggleExpand: (memberId: string) => void;
    onExpandAll: () => void;
    onCollapseAll: () => void;
    allExpanded: boolean;
  };
  pagination: {
    page: number;
    totalPages: number;
    pageSize: number;
    onPageChange: (next: number) => void;
  };
  selection: {
    selectedId: string | null;
    selected: CongressionalSelection | null;
    onToggle: (id: string) => void;
    onOpenProfile: (selection: CongressionalSelection) => void;
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
  const role = readList(searchParams, 'role');
  const committee = readList(searchParams, 'committee');
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);
  const selectedId = searchParams.get('profile');

  // Expansion is view state, not a filter: it changes nothing about which
  // records match, so it stays out of the URL and off the query key.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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

  /**
   * Offices A–Z. `sort` is passed explicitly because omitting it makes the
   * endpoint default to `recent` (last touchpoint), which reads as arbitrary
   * ordering in a directory — the same reason the Outreach picker pins it.
   */
  const officesQuery = useQuery({
    queryKey: ['directory-offices', query, chamber, state, issue, role, committee, page],
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: {
            q: query || undefined,
            chamber: chamber.length === 1 ? chamber[0] : undefined,
            state: state.length ? state : undefined,
            issue: issue.length ? issue : undefined,
            role: role.length ? role : undefined,
            committee: committee.length ? committee : undefined,
            sort: 'name-asc',
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
  const roleOptions = useMemo<DirectoryFilterOption[]>(
    () => (filterValuesQuery.data?.roles ?? []).map((value: string) => ({ value, label: value })),
    [filterValuesQuery.data],
  );
  const committeeOptions = useMemo<DirectoryFilterOption[]>(
    () =>
      (filterValuesQuery.data?.committees ?? []).map((value: string) => ({ value, label: value })),
    [filterValuesQuery.data],
  );

  const contacts = useMemo(() => officesQuery.data?.contacts ?? [], [officesQuery.data]);
  const total = officesQuery.data?.total ?? 0;
  const staffTotal = officesQuery.data?.totals.staff ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / CONGRESSIONAL_STAFF_PAGE_SIZE));

  const offices = useMemo<CongressionalOfficeRow[]>(
    () =>
      contacts.map((member) => {
        // Mirrors the server predicate that let this office through: a staffer
        // is shown when they carry a selected role or a selected issue.
        const narrowed =
          role.length || issue.length
            ? member.staff.filter(
                (person) =>
                  person.roles.some((value) => role.includes(value)) ||
                  person.issueAreas.some((value) => issue.includes(value)),
              )
            : member.staff;
        return {
          member,
          staff: narrowed,
          staffTotal: member.staff.length,
          isExpanded: expanded.has(member.id),
        };
      }),
    [contacts, role, issue, expanded],
  );

  const toggleExpand = useCallback((memberId: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }, []);

  const allExpanded = offices.length > 0 && offices.every((office) => office.isExpanded);
  const expandAll = useCallback(
    () => setExpanded(new Set(contacts.map((member) => member.id))),
    [contacts],
  );
  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  /**
   * The selected id addresses either kind of row, so it is resolved against
   * both the office list and every visible roster. A staffer id that is not on
   * the current page resolves to nothing, which is the honest answer — the rail
   * then reports that nothing is selected rather than a half-built profile.
   */
  const selected = useMemo<CongressionalSelection | null>(() => {
    if (!selectedId) return null;
    const office = contacts.find((member) => member.id === selectedId);
    if (office) return { kind: 'member', id: office.id, member: office };
    for (const member of contacts) {
      const person = member.staff.find((entry) => entry.id === selectedId);
      if (person) return { kind: 'staff', id: person.id, staff: person, member };
    }
    return null;
  }, [contacts, selectedId]);

  // The rail's committee + provenance lines live on the staff *detail* contract,
  // not the list row, so they are fetched for a selected staffer only. A member
  // carries their own committees on the row, so no second request is made.
  const staffDetailId = selected?.kind === 'staff' ? selected.id : null;
  const detailQuery = useQuery({
    queryKey: ['directory-staff-detail', staffDetailId],
    queryFn: () => getStaffDetail(api, staffDetailId as string),
    enabled: Boolean(staffDetailId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const committeeNames = detailQuery.data?.committeeAssociations?.length
    ? detailQuery.data.committeeAssociations
        .map((association) => association.position ?? association.committeeId)
        .slice(0, 2)
        .join(' · ')
    : null;

  const memberDetail: CongressionalStaffDetailModel = {
    isLoading: false,
    isError: false,
    committeeNames: selected?.kind === 'member' ? selected.member.committees.slice(0, 2).join(' · ') || null : null,
    // A member's photo is already on their list row; no detail fetch needed.
    photoUrl: selected?.kind === 'member' ? selected.member.photoUrl || null : null,
    // The snapshot id is a property of the whole payload, so a member needs no
    // extra request to state its provenance.
    sourceSnapshotId: officesQuery.data?.sourceId ?? null,
    onRetry: () => void officesQuery.refetch(),
  };

  return {
    search: {
      text: searchText,
      onChange: setSearchText,
    },
    filters: {
      chamber,
      state,
      issue,
      role,
      committee,
      chamberOptions: CHAMBER_OPTIONS,
      stateOptions,
      issueOptions,
      roleOptions,
      committeeOptions,
      hasAny:
        Boolean(query) ||
        chamber.length > 0 ||
        state.length > 0 ||
        issue.length > 0 ||
        role.length > 0 ||
        committee.length > 0,
      onChange: setFilter,
      onClearAll: clearAll,
    },
    results: {
      offices,
      total,
      staffTotal,
      isInitialLoading: officesQuery.isLoading && !officesQuery.data,
      isRefetching: officesQuery.isFetching && Boolean(officesQuery.data),
      isError: officesQuery.isError,
      onRetry: () => void officesQuery.refetch(),
      onToggleExpand: toggleExpand,
      onExpandAll: expandAll,
      onCollapseAll: collapseAll,
      allExpanded,
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
      onOpenProfile: (target) =>
        navigate(
          target.kind === 'member'
            ? DIRECTORY_PROFILE_ROUTES.member(target.member.id)
            : DIRECTORY_PROFILE_ROUTES.staff(target.id),
        ),
      detail:
        selected?.kind === 'member'
          ? memberDetail
          : {
              isLoading: detailQuery.isLoading,
              isError: detailQuery.isError,
              committeeNames,
              photoUrl: detailQuery.data?.photoUrl ?? null,
              // Guarded with `?.`: a detail payload without `source` is exactly
              // the required "provenance missing" state, and crashed an earlier
              // draft.
              sourceSnapshotId: detailQuery.data?.source?.snapshotId ?? null,
              onRetry: () => void detailQuery.refetch(),
            },
    },
  };
}
