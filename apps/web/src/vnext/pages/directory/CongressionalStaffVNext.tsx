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
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill, type DirectoryFilterOption } from './DirectoryFilterPill.js';
import { DIRECTORY_PROFILE_ROUTES } from './directory-routes.js';

const PAGE_SIZE = 12;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * `/api/directory/staffers` accepts q, chamber, state, issue, page and pageSize —
 * verified against `directory.controller.ts`. There is deliberately no `role` or
 * `committee` parameter, so those two designed pills state that they are not
 * filterable yet instead of quietly filtering only the page in hand and
 * reporting a wrong result count.
 */
const UNFILTERABLE_NOTE =
  'Not filterable yet: the canonical staff directory endpoint does not accept this dimension. Search matches role and committee text in the meantime.';

const CHAMBER_OPTIONS: readonly DirectoryFilterOption[] = [
  { value: 'House', label: 'House' },
  { value: 'Senate', label: 'Senate' },
];

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  return raw ? raw.split(',').filter(Boolean) : [];
}

/** Coverage reads roles first, then issue areas; both are per-row API fields. */
function coverageLines(staffer: DirectoryStaffer): { primary: string; secondary: string } {
  const issues = staffer.issueAreas.filter(Boolean);
  const roles = staffer.roles.filter(Boolean);
  return {
    primary: issues.length ? issues.slice(0, 2).join(' · ') : '—',
    secondary: roles.length ? roles.slice(0, 2).join(' · ') : 'No coverage recorded',
  };
}

function officeLines(staffer: DirectoryStaffer): { primary: string; secondary: string } {
  const { member, officeLocation } = staffer;
  const seat = [member.state, member.district].filter(Boolean).join('-');
  const honorific = member.chamber === 'Senate' ? 'Sen.' : member.chamber === 'House' ? 'Rep.' : '';
  const primary = [honorific, member.memberName || member.fullName].filter(Boolean).join(' ');
  return {
    primary: seat ? `${primary} · ${seat}` : primary || '—',
    secondary: [member.chamber, officeLocation || 'Personal office'].filter(Boolean).join(' · '),
  };
}

export function CongressionalStaffVNext() {
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
            pageSize: PAGE_SIZE,
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
  const isInitialLoading = staffersQuery.isLoading && !staffersQuery.data;
  const isRefetching = staffersQuery.isFetching && Boolean(staffersQuery.data);
  const hasFilters = Boolean(query) || chamber.length > 0 || state.length > 0 || issue.length > 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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

  return (
    <DirectoryShell
      eyebrow="Directory · Congressional Staff"
      title="Congressional Staff"
      subtitle="Members, personal offices and staff across the House and Senate."
      metrics={[
        { label: 'Scope', value: 'House + Senate' },
        { label: 'Discovery', value: 'Role + Issue' },
        { label: 'Identity', value: 'Canonical' },
      ]}
    >
      <div className="capiro-directory-ribbon">
        <span className="capiro-directory-ribbon__accent" aria-hidden="true" />
        <p className="capiro-directory-ribbon__label">Directory signals</p>
        <span className="capiro-directory-ribbon__spacer" />
        <CapiroBadge tone="info">{total ? `${total} staff` : 'No staff'}</CapiroBadge>
        <CapiroBadge tone="neutral">{`Page ${Math.min(page, totalPages)} of ${totalPages}`}</CapiroBadge>
        {isRefetching ? <CapiroBadge tone="warning">Refreshing</CapiroBadge> : null}
      </div>

      <div className="capiro-directory-toolbar">
        <div className="capiro-directory-search">
          <label className="capiro-directory-search__label" htmlFor="directory-congressional-search">
            Search
          </label>
          <input
            id="directory-congressional-search"
            className="capiro-directory-search__input"
            type="search"
            value={searchText}
            placeholder="Name, role, member, issue or committee…"
            onChange={(event) => setSearchText(event.target.value)}
          />
          {searchText ? (
            <button
              type="button"
              className="capiro-directory-search__clear"
              onClick={() => setSearchText('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>

        <DirectoryFilterPill
          label="Chamber"
          options={CHAMBER_OPTIONS}
          selected={chamber}
          multiple={false}
          onChange={(next) => setFilter('chamber', next)}
        />
        <DirectoryFilterPill
          label="State"
          options={stateOptions}
          selected={state}
          onChange={(next) => setFilter('state', next)}
        />
        <DirectoryFilterPill label="Role" options={[]} selected={[]} onChange={() => {}} unavailableReason={UNFILTERABLE_NOTE} />
        <DirectoryFilterPill
          label="Issue Area"
          options={issueOptions}
          selected={issue}
          onChange={(next) => setFilter('issue', next)}
        />
        <DirectoryFilterPill label="Committee" options={[]} selected={[]} onChange={() => {}} unavailableReason={UNFILTERABLE_NOTE} />

        {hasFilters ? (
          <button
            type="button"
            className="capiro-directory-toolbar__reset"
            onClick={() =>
              commit((next) => {
                ['q', 'chamber', 'state', 'issue', 'page'].forEach((key) => next.delete(key));
              })
            }
          >
            Clear all
          </button>
        ) : null}
      </div>

      <div className="capiro-directory-split">
        <div
          className={`capiro-directory-results capiro-directory-results--congressional${
            isRefetching ? ' capiro-directory-results--refetching' : ''
          }`}
        >
          <div className="capiro-directory-results__header">
            <p className="capiro-directory-results__eyebrow">Congressional Staff</p>
            <p className="capiro-directory-results__count">
              {isInitialLoading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
            </p>
          </div>

          <div className="capiro-directory-columns capiro-directory-row-grid">
            <p className="capiro-directory-columns__label">Staffer</p>
            <p className="capiro-directory-columns__label">Member / Office</p>
            <p className="capiro-directory-columns__label">Coverage</p>
            <p className="capiro-directory-columns__label">Contact</p>
            <p className="capiro-directory-columns__label" aria-hidden="true" />
          </div>

          {staffersQuery.isError ? (
            <CapiroErrorState
              title="Congressional staff could not be loaded"
              description="The canonical staff directory did not respond."
              onRetry={() => void staffersQuery.refetch()}
            />
          ) : isInitialLoading ? (
            <>
              {Array.from({ length: 6 }, (_, index) => (
                <div className="capiro-directory-row capiro-directory-row-grid" key={index}>
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                </div>
              ))}
            </>
          ) : staffers.length === 0 ? (
            <CapiroEmptyState
              title={hasFilters ? 'No staff match these filters' : 'No congressional staff available'}
              description={
                hasFilters
                  ? 'Clear a filter or broaden the search to see more of the directory.'
                  : 'The canonical staff directory returned no records.'
              }
              action={
                hasFilters ? (
                  <CapiroButton
                    size="compact"
                    onClick={() =>
                      commit((next) => {
                        ['q', 'chamber', 'state', 'issue', 'page'].forEach((key) => next.delete(key));
                      })
                    }
                  >
                    Clear filters
                  </CapiroButton>
                ) : undefined
              }
            />
          ) : (
            staffers.map((staffer) => {
              const office = officeLines(staffer);
              const coverage = coverageLines(staffer);
              const isSelected = staffer.id === selectedId;
              return (
                <button
                  type="button"
                  key={staffer.id}
                  aria-pressed={isSelected}
                  className={`capiro-directory-row capiro-directory-row-grid${
                    isSelected ? ' capiro-directory-row--selected' : ''
                  }`}
                  onClick={() =>
                    commit((next) => {
                      if (isSelected) next.delete('profile');
                      else next.set('profile', staffer.id);
                    })
                  }
                >
                  <span className="capiro-directory-cell capiro-directory-cell--identity">
                    <span className="capiro-directory-cell__primary">{staffer.fullName}</span>
                    <span className="capiro-directory-cell__secondary">{staffer.title || '—'}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{office.primary}</span>
                    <span className="capiro-directory-cell__secondary">{office.secondary}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{coverage.primary}</span>
                    <span className="capiro-directory-cell__secondary">{coverage.secondary}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono capiro-directory-cell--contact">
                    <span className="capiro-directory-cell__primary">{staffer.email || 'No email'}</span>
                    <span className="capiro-directory-cell__secondary">{staffer.phone || 'No phone'}</span>
                  </span>
                  <span className="capiro-directory-cell">
                    <span className="capiro-directory-cell__action" aria-hidden="true">
                      Open →
                    </span>
                  </span>
                </button>
              );
            })
          )}

          {total > PAGE_SIZE ? (
            <div className="capiro-directory-pagination">
              <CapiroButton
                size="compact"
                disabled={page <= 1}
                onClick={() => commit((next) => next.set('page', String(page - 1)))}
              >
                Previous
              </CapiroButton>
              <p className="capiro-directory-pagination__status">
                Page {Math.min(page, totalPages)} of {totalPages}
              </p>
              <CapiroButton
                size="compact"
                disabled={page >= totalPages}
                onClick={() => commit((next) => next.set('page', String(page + 1)))}
              >
                Next
              </CapiroButton>
            </div>
          ) : null}
        </div>

        <SelectedStaffRail
          staffer={selected}
          detail={detailQuery}
          onOpenProfile={(id) => navigate(DIRECTORY_PROFILE_ROUTES.staff(id))}
        />
      </div>
    </DirectoryShell>
  );
}

type DetailQuery = {
  data?: Awaited<ReturnType<typeof getStaffDetail>>;
  isLoading: boolean;
  isError: boolean;
  refetch: () => unknown;
};

function SelectedStaffRail({
  staffer,
  detail,
  onOpenProfile,
}: {
  staffer: DirectoryStaffer | null;
  detail: DetailQuery;
  onOpenProfile: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [staffer?.id]);

  if (!staffer) {
    return (
      <aside className="capiro-directory-rail" aria-label="Selected staff profile">
        <p className="capiro-directory-rail__eyebrow">Selected staff profile</p>
        <CapiroEmptyState
          title="No one selected"
          description="Choose a row to see contact, coverage and committee context."
        />
      </aside>
    );
  }

  const person = staffer;
  const office = officeLines(person);
  const committeeNames = detail.data?.committeeAssociations?.length
    ? detail.data.committeeAssociations
        .map((association) => association.position ?? association.committeeId)
        .slice(0, 2)
        .join(' · ')
    : null;

  async function copyEmail() {
    const email = person.email;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopyState('copied');
    } catch {
      // Clipboard can be denied by permissions policy or an insecure context;
      // the failure is surfaced rather than swallowed.
      setCopyState('failed');
    }
  }

  return (
    <aside className="capiro-directory-rail" aria-label="Selected staff profile">
      <p className="capiro-directory-rail__eyebrow">Selected staff profile</p>

      <IdentityMark
        kind="person"
        size="lg"
        name={person.fullName}
        metadata={person.title}
        metadataVisible
      />

      <p className="capiro-directory-rail__office">{`Office of ${office.primary}`}</p>
      <span className="capiro-directory-rail__divider" aria-hidden="true" />

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Email</p>
        <p className="capiro-directory-field__value">{person.email || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Phone</p>
        <p className="capiro-directory-field__value">{person.phone || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Coverage</p>
        <p className="capiro-directory-field__value">{coverageLines(person).primary}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Committee</p>
        <p className="capiro-directory-field__value">
          {detail.isLoading
            ? 'Loading…'
            : detail.isError
              ? 'Unavailable'
              : (committeeNames ?? 'None recorded')}
        </p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Source</p>
        <p className="capiro-directory-field__value">
          {detail.isLoading
            ? 'Loading…'
            : (detail.data?.source?.snapshotId ?? 'Provenance unavailable')}
        </p>
      </div>

      {detail.isError ? (
        <CapiroErrorState
          title="Profile detail unavailable"
          description="Contact and coverage above come from the list record."
          onRetry={() => void detail.refetch()}
        />
      ) : null}

      <div className="capiro-directory-rail__actions">
        <CapiroButton variant="primary" size="compact" onClick={() => onOpenProfile(person.id)}>
          Open full profile
        </CapiroButton>
        <CapiroButton size="compact" onClick={() => void copyEmail()} disabled={!person.email}>
          {copyState === 'copied' ? 'Email copied' : copyState === 'failed' ? 'Copy failed' : 'Copy email'}
        </CapiroButton>
      </div>
      {/* Clipboard outcome is announced, not just recoloured. */}
      <p className="capiro-directory-field__label" role="status" aria-live="polite">
        {copyState === 'copied' ? 'Email copied to clipboard' : copyState === 'failed' ? 'Clipboard unavailable' : ''}
      </p>

      <div className="capiro-directory-workflows">
        <p className="capiro-directory-workflows__eyebrow">Connected workflows</p>
        <p className="capiro-directory-workflows__copy">
          This person keeps the same canonical identity across dependent Capiro workflows.
        </p>
        <div className="capiro-directory-workflows__badges">
          <CapiroBadge tone="info">Engagement</CapiroBadge>
          <CapiroBadge tone="info">Outreach</CapiroBadge>
          <CapiroBadge tone="info">Quick Log</CapiroBadge>
        </div>
      </div>
    </aside>
  );
}
