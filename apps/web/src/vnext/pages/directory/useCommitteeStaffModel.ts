import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  CommitteeChamber,
  DirectoryCommittee,
  DirectoryCommitteesResponse,
  DirectoryCommitteeStaffResponse,
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';
import { getCommitteeDetail } from '../../../pages/directory/directory-api.js';
import type { CommitteeRef } from '../../../pages/directory/directory-api.js';
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

/**
 * One committee-or-subcommittee unit with the roster the SOURCE attributes to
 * that unit's own office.
 *
 * Previously the page fetched exactly one roster — the selected committee's —
 * and rendered every staffer as one flat, unattributed pool, with a note
 * saying unit placement "is not source-backed". That was wrong about the
 * source: `/api/directory/committees/:id/staff` is keyed on the committee
 * OFFICE (`positions[].office.office_id`), and every subcommittee is its own
 * office with its own id. So a subcommittee's roster is directly fetchable —
 * we simply never asked for it. Fanning the same endpoint out over the parent
 * plus each `subcommittees[]` id yields real per-unit staff attribution with
 * no synthesis whatsoever.
 */
export interface CommitteeStaffGroup {
  committeeId: string;
  name: string;
  /** Subcommittee display name with the redundant parent prefix stripped. */
  shortName: string;
  kind: 'committee' | 'subcommittee';
  chamber: CommitteeChamber | null;
  staff: DirectoryCommitteeStaffer[];
  currentCount: number;
  formerCount: number;
  isLoading: boolean;
}

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
    /**
     * Real subcommittee-unit structure for the selected committee (DIR-1:
     * structure only — per-unit staff PLACEMENT is not source-backed, so
     * these render as structural nodes, never with a nested roster).
     * Sourced from `getCommitteeDetail`, which computes `subcommittees`
     * server-side against the full dataset — NOT from the `committees`
     * picker list above, which is filtered by the shared search box and
     * would silently drop unrelated subcommittees while a staffer search
     * is active.
     */
    units: CommitteeRef[];
    isLoadingUnits: boolean;
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
    /**
     * The same people as `staff`, partitioned into the committee/subcommittee
     * unit the source attributes each of them to. Ordered parent-first, then
     * subcommittees by headcount then name.
     */
    groups: CommitteeStaffGroup[];
    /** Units still resolving their roster (fan-out is per-unit, so partial). */
    isLoadingGroups: boolean;
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

/**
 * Subcommittee names repeat their parent committee's full name as a literal
 * prefix (source data, not a display choice) — stripped so a group header shows
 * only the part that distinguishes it from its siblings. Exported because the
 * chart, the roster group header and the contact card must all say the same
 * thing about the same unit.
 */
export function stripCommitteePrefix(name: string, committeeName: string): string {
  if (!committeeName) return name;
  const prefix = `${committeeName} `;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
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

  // Real subcommittee structure for the hierarchy canvas's units tier.
  // Deliberately a separate query against getCommitteeDetail, not a client-
  // side filter of `committees` above — see the interface doc comment.
  const unitsQuery = useQuery({
    queryKey: ['directory-committee-detail', effectiveCommitteeId],
    queryFn: () => getCommitteeDetail(api, effectiveCommitteeId as string),
    enabled: effectiveCommitteeId !== null,
    staleTime: 5 * 60_000,
    retry: 1,
  });
  const units = useMemo(() => unitsQuery.data?.subcommittees ?? [], [unitsQuery.data]);

  // Per-unit rosters. One query per subcommittee against the SAME endpoint the
  // parent roster uses — a subcommittee is its own committee office, so its
  // roster is source-backed exactly like the parent's. React Query dedupes and
  // caches each unit independently, and the parent roster above is reused as
  // this list's first entry rather than re-fetched.
  const unitStaffQueries = useQueries({
    queries: units.map((unit) => ({
      queryKey: ['directory-committee-staff', unit.id],
      queryFn: async () =>
        (
          await api.get<DirectoryCommitteeStaffResponse>(
            `/api/directory/committees/${encodeURIComponent(unit.id)}/staff`,
            { params: { pageSize: COMMITTEE_STAFF_PAGE_SIZE } },
          )
        ).data,
      staleTime: 5 * 60_000,
      retry: 1,
    })),
  });

  // The search box filters PEOPLE inside the groups too, so a name search
  // narrows the org chart to the units that actually contain that person
  // instead of leaving every unit at full roster while the header count drops.
  const staffMatches = useCallback(
    (staffer: DirectoryCommitteeStaffer) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return true;
      return [staffer.fullName, staffer.title, staffer.email, staffer.committee?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    },
    [query],
  );

  const unitStaffSignature = unitStaffQueries
    .map((entry) => `${entry.data?.committee?.id ?? ''}:${entry.data?.staff.length ?? -1}:${entry.isLoading ? 'l' : 'r'}`)
    .join('|');

  const groups = useMemo<CommitteeStaffGroup[]>(() => {
    const built: CommitteeStaffGroup[] = [];
    const seen = new Set<string>();

    const push = (
      committeeId: string,
      name: string,
      shortName: string,
      kind: 'committee' | 'subcommittee',
      chamber: CommitteeChamber | null,
      roster: DirectoryCommitteeStaffer[],
      isLoading: boolean,
    ) => {
      if (seen.has(committeeId)) return;
      seen.add(committeeId);
      const filtered = roster.filter(staffMatches);
      built.push({
        committeeId,
        name,
        shortName,
        kind,
        chamber,
        staff: filtered,
        currentCount: filtered.filter((person) => person.isCurrent).length,
        formerCount: filtered.filter((person) => !person.isCurrent).length,
        isLoading,
      });
    };

    if (committeeDetail) {
      push(
        committeeDetail.id,
        committeeDetail.name,
        committeeDetail.name,
        committeeDetail.kind,
        committeeDetail.chamber,
        staff,
        false,
      );
    }

    units.forEach((unit, index) => {
      const entry = unitStaffQueries[index];
      push(
        unit.id,
        unit.name,
        stripCommitteePrefix(unit.name, committeeDetail?.name ?? ''),
        unit.kind === 'subcommittee' ? 'subcommittee' : 'committee',
        entry?.data?.committee?.chamber ?? committeeDetail?.chamber ?? null,
        entry?.data?.staff ?? [],
        Boolean(entry?.isLoading),
      );
    });

    // Parent stays first (it is the root of the chart); subcommittees sort by
    // real headcount so the substantive units read first.
    const [parent, ...rest] = built;
    rest.sort((left, right) => {
      if (right.currentCount !== left.currentCount) return right.currentCount - left.currentCount;
      return left.shortName.localeCompare(right.shortName);
    });
    return parent ? [parent, ...rest] : rest;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committeeDetail, staff, units, unitStaffSignature, staffMatches]);

  const isLoadingGroups = unitStaffQueries.some((entry) => entry.isLoading);

  // Selection can now land on a person from ANY unit's roster, not just the
  // parent committee's — resolve against the union so the rail/modal open.
  const selectedFromGroups = selectedId
    ? groups.flatMap((group) => group.staff).find((person) => person.id === selectedId) ?? null
    : null;

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
      units,
      isLoadingUnits: unitsQuery.isLoading && !unitsQuery.data,
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
      groups,
      isLoadingGroups,
      isInitialLoading: staffQuery.isLoading && !staffQuery.data,
      isRefetching: staffQuery.isFetching && Boolean(staffQuery.data),
      isError: staffQuery.isError,
      onRetry: () => void staffQuery.refetch(),
    },
    selection: {
      selectedId,
      selected: selected ?? selectedFromGroups,
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
