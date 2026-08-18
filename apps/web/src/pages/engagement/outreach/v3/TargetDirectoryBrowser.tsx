/**
 * Directory source for Outreach V3 Targets — behaviour parity with Outreach V2.
 *
 * WHY THIS EXISTS
 *
 * The Directory tab used to run the governed `search_targets` capability with
 * `sources: ['directory_member', 'directory_staff', 'state_legislator']` and
 * `limit: 20`. That capability merges all three sources into one candidate
 * pool, sorts by a relevance score and slices to `limit`, so the tab showed a
 * ~20-row score-ranked blend — never the directory. V2's Directory tab
 * (`StepRecipientsSelect`) instead reads `GET /api/directory/contacts` with
 * `pageSize: 50`, `sort: 'name-asc'` and no query, so it shows the whole
 * directory A–Z with staffers nested under each member. This component reads
 * the SAME endpoint with the SAME parameters, so "everyone I see in V2" is
 * everyone visible here.
 *
 * WHAT STAYS GOVERNED
 *
 * Browsing is a read. Selection is not: a row is added with the canonical
 * `ADD_TARGET_REFS` command carrying only a locator (`{ source, id }` — the
 * locator schema for directory sources is `.strict()` and accepts nothing
 * else). The backend re-resolves that locator through `DirectoryService` and
 * writes the snapshot itself, so nothing displayed here is trusted as the
 * stored target. A browser reference is never authorization.
 *
 * State legislators are NOT in this tab. They have their own tab, still on the
 * governed capability, because folding them in here is exactly what made the
 * merged 20-slot pool crowd out members in the first place.
 */
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  Search,
  Star,
  UserRound,
} from 'lucide-react';
import { useApi } from '../../../../lib/use-api.js';
import type { DirectoryApiResponse, DirectoryEntry } from '../../../directory/directoryData.js';
import type {
  OutreachV3Command,
  OutreachV3ResolvedTargetRef,
  OutreachV3TargetLocator,
} from './contracts.js';
import { addTargetCommand, removeTargetCommand } from './commands.js';
import { safeOutreachV3Error } from './outreach-v3-api.js';

/** Same row shape the directory favorites API returns for V2. */
interface FavoriteRow {
  directoryContactId: string;
  directoryContactName: string | null;
}

export interface TargetDirectoryBrowserProps {
  selected: OutreachV3ResolvedTargetRef[];
  busy: boolean;
  applyCommands: (commands: OutreachV3Command[]) => Promise<unknown>;
  /** Opens the governed target-profile inspector for a row. */
  onProfile: (locator: OutreachV3TargetLocator) => void;
}

/** V2 parity: 50 rows a page, A–Z. Omitting `sort` makes the backend default
 *  to 'recent' (lastTouchpoint), which reads as arbitrary ordering. */
const PAGE_SIZE = 50;

function memberLocator(entry: DirectoryEntry): OutreachV3TargetLocator {
  return { source: 'directory_member', id: entry.id };
}

function staffLocator(staffer: DirectoryEntry['staff'][number]): OutreachV3TargetLocator {
  return { source: 'directory_staff', id: staffer.id };
}

function locatorKey(locator: OutreachV3TargetLocator): string {
  return `${locator.source}:${locator.id}`;
}

export function TargetDirectoryBrowser({
  selected,
  busy,
  applyCommands,
  onProfile,
}: TargetDirectoryBrowserProps) {
  const api = useApi();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  const [chamberFilter, setChamberFilter] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Same 250ms debounce V2 uses, so typing does not fire a request per keypress.
  // Page 3 of the old result set is not page 3 of the new one, so a committed
  // query resets the page in the SAME state update — resetting it in a separate
  // effect would render once with (new query, old page) and fire a request for
  // a page that is immediately discarded.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [search]);

  const directory = useQuery<DirectoryApiResponse>({
    // Without this the response is dropped on every key change, so the rows,
    // the office count AND the state/chamber option lists (which come from the
    // same payload) all blank out mid-request — the filter you are using
    // disappears while it loads.
    placeholderData: keepPreviousData,
    queryKey: ['ov3-target-directory', query, stateFilter, chamberFilter, page],
    queryFn: async () =>
      (
        await api.get<DirectoryApiResponse>('/api/directory/contacts', {
          params: {
            q: query || undefined,
            state: stateFilter || undefined,
            chamber: chamberFilter || undefined,
            page,
            pageSize: PAGE_SIZE,
            sort: 'name-asc',
          },
        })
      ).data,
  });

  const favorites = useQuery<FavoriteRow[]>({
    queryKey: ['directory-favorites'],
    queryFn: async () => (await api.get<FavoriteRow[]>('/api/directory/favorites')).data,
  });

  // V2 parity: the favorites store is shared with client-contact surfaces,
  // which write namespaced `clientperson:` ids. Excluding them keeps the count
  // and the filter about directory members only.
  const favoriteIds = useMemo(
    () =>
      new Set(
        (favorites.data ?? [])
          .filter((row) => !row.directoryContactId.startsWith('clientperson:'))
          .map((row) => row.directoryContactId),
      ),
    [favorites.data],
  );

  const toggleFavorite = useMutation({
    mutationFn: async (input: { id: string; name: string; favorited: boolean }) =>
      input.favorited
        ? (await api.delete(`/api/directory/contacts/${encodeURIComponent(input.id)}/favorite`))
            .data
        : (
            await api.post(`/api/directory/contacts/${encodeURIComponent(input.id)}/favorite`, {
              directoryContactName: input.name,
            })
          ).data,
    onSettled: () => qc.invalidateQueries({ queryKey: ['directory-favorites'] }),
  });

  const selectedByLocator = useMemo(() => {
    const map = new Map<string, OutreachV3ResolvedTargetRef>();
    for (const target of selected) map.set(locatorKey(target.locator), target);
    return map;
  }, [selected]);

  const rows = useMemo(() => {
    const contacts = directory.data?.contacts ?? [];
    if (!favoritesOnly) return contacts;
    return contacts.filter((entry) => favoriteIds.has(entry.id));
  }, [directory.data?.contacts, favoriteIds, favoritesOnly]);

  const states = directory.data?.availableStates ?? [];
  const chambers = directory.data?.availableFilters.chambers ?? [];
  const total = directory.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const add = async (locator: OutreachV3TargetLocator) => {
    setError(null);
    try {
      await applyCommands([addTargetCommand(locator)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const remove = async (targetKey: string) => {
    setError(null);
    try {
      await applyCommands([removeTargetCommand(targetKey)]);
    } catch (caught) {
      setError(safeOutreachV3Error(caught));
    }
  };

  const toggleExpand = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * One add/added control, shared by member and staffer rows.
   *
   * A plain render helper, NOT a component declared in the body: the latter
   * would be a new component type on every render, remounting every button.
   */
  const addControl = (locator: OutreachV3TargetLocator) => {
    const target = selectedByLocator.get(locatorKey(locator));
    if (target) {
      return (
        <button
          type="button"
          className="ov3-dir__add is-added"
          disabled={busy}
          title="Added to this campaign — click to remove"
          aria-label="Added — click to remove"
          onClick={() => void remove(target.targetKey)}
        >
          <Check size={14} aria-hidden="true" />
        </button>
      );
    }
    return (
      <button
        type="button"
        className="ov3-dir__add"
        disabled={busy}
        title="Add to this campaign"
        aria-label="Add to this campaign"
        onClick={() => void add(locator)}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
    );
  };

  return (
    <section className="ov3-dir" aria-label="Directory">
      <div className="ov3-dir__toolbar">
        <label className="ov3-dir__search">
          <Search size={16} aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search members and staffers…"
            aria-label="Search the Directory"
          />
          {directory.isFetching ? (
            <Loader2 className="ov3-spin" size={15} aria-label="Searching" />
          ) : null}
        </label>
        <label className="ov3-dir__filter">
          <select
            aria-label="Filter by state"
            value={stateFilter}
            onChange={(event) => {
              setStateFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All states</option>
            {states.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <label className="ov3-dir__filter">
          <select
            aria-label="Filter by chamber"
            value={chamberFilter}
            onChange={(event) => {
              setChamberFilter(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All chambers</option>
            {chambers.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`ov3-dir__favtoggle${favoritesOnly ? ' is-on' : ''}`}
          aria-pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((value) => !value)}
        >
          <Star size={14} aria-hidden="true" />
          Favorites ({favoriteIds.size})
        </button>
      </div>

      <p className="ov3-dir__hint">
        Showing the Directory A–Z. Add any member or staffer with +. Use the caret to expand an
        office&apos;s staffers.
      </p>

      {error || directory.isError ? (
        <div className="ov3-recovery is-danger" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>
              {error ? 'This action could not complete' : 'The Directory could not be loaded'}
            </strong>
            <p>{error ?? safeOutreachV3Error(directory.error)}</p>
          </div>
        </div>
      ) : null}

      <div className="ov3-dir__table">
        <div className="ov3-dir__head" aria-hidden="true">
          <span />
          <span>Name</span>
          <span>Office</span>
          <span>Committee</span>
          <span>State</span>
          <span>Party</span>
        </div>

        {directory.isLoading ? (
          <div className="ov3-dir__empty">Loading the Directory…</div>
        ) : rows.length === 0 ? (
          <div className="ov3-dir__empty">
            {favoritesOnly
              ? 'No favorites on this page. Star members to find them faster.'
              : 'No members match. Try a different search or filter.'}
          </div>
        ) : (
          rows.map((entry) => {
            const locator = memberLocator(entry);
            const isExpanded = expanded.has(entry.id);
            const favorited = favoriteIds.has(entry.id);
            const memberTarget = selectedByLocator.get(locatorKey(locator));
            return (
              <div key={entry.id} className="ov3-dir__office">
                <div className="ov3-dir__row" data-added={Boolean(memberTarget) || undefined}>
                  <span className="ov3-dir__controls">
                    <button
                      type="button"
                      className="ov3-dir__caret"
                      onClick={() => toggleExpand(entry.id)}
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? 'Collapse staffers' : 'Expand staffers'}
                    >
                      {isExpanded ? (
                        <ChevronDown size={14} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={14} aria-hidden="true" />
                      )}
                    </button>
                    {addControl(locator)}
                    <button
                      type="button"
                      className={`ov3-dir__star${favorited ? ' is-on' : ''}`}
                      aria-pressed={favorited}
                      aria-label={favorited ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={() =>
                        toggleFavorite.mutate({
                          id: entry.id,
                          name: entry.fullName,
                          favorited,
                        })
                      }
                    >
                      <Star size={14} aria-hidden="true" />
                    </button>
                  </span>
                  <button
                    type="button"
                    className="ov3-dir__who"
                    onClick={() => onProfile(locator)}
                    title={`View ${entry.fullName}`}
                  >
                    <strong>{entry.fullName}</strong>
                    <small>{entry.leadershipPositions[0] || entry.title || 'Member'}</small>
                  </button>
                  <span className="ov3-dir__cell" title={entry.office}>
                    {entry.office || '—'}
                  </span>
                  <span className="ov3-dir__cell" title={entry.committees.join(', ')}>
                    {entry.committees[0] || '—'}
                  </span>
                  <span className="ov3-dir__cell">{entry.state || '—'}</span>
                  <span className="ov3-dir__cell">{entry.partyName || '—'}</span>
                </div>

                {isExpanded ? (
                  entry.staff.length === 0 ? (
                    <div className="ov3-dir__row is-staff">
                      <span className="ov3-dir__controls" />
                      <span className="ov3-dir__who is-static">
                        <small>No staffer contacts synced for this office.</small>
                      </span>
                      <span className="ov3-dir__cell" />
                      <span className="ov3-dir__cell" />
                      <span className="ov3-dir__cell" />
                      <span className="ov3-dir__cell" />
                    </div>
                  ) : (
                    entry.staff.map((staffer) => {
                      const sLocator = staffLocator(staffer);
                      const sTarget = selectedByLocator.get(locatorKey(sLocator));
                      return (
                        <div
                          key={staffer.id}
                          className="ov3-dir__row is-staff"
                          data-added={Boolean(sTarget) || undefined}
                        >
                          <span className="ov3-dir__controls">
                            <span className="ov3-dir__caret is-spacer" aria-hidden="true">
                              <UserRound size={13} />
                            </span>
                            {addControl(sLocator)}
                          </span>
                          <button
                            type="button"
                            className="ov3-dir__who"
                            onClick={() => onProfile(sLocator)}
                            title={`View ${staffer.fullName}`}
                          >
                            <strong>{staffer.fullName}</strong>
                            <small>{staffer.title || 'Staffer'}</small>
                          </button>
                          <span className="ov3-dir__cell" title={entry.office}>
                            {entry.office || '—'}
                          </span>
                          <span className="ov3-dir__cell">{staffer.issueAreas[0] || '—'}</span>
                          <span className="ov3-dir__cell">{entry.state || '—'}</span>
                          <span className="ov3-dir__cell">—</span>
                        </div>
                      );
                    })
                  )
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div className="ov3-dir__pager">
        <span>
          {total === 0
            ? 'No offices'
            : `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, total)} of ${total} offices`}
        </span>
        <button
          type="button"
          className="ov3-button is-quiet"
          disabled={page <= 1 || directory.isFetching}
          onClick={() => setPage((value) => Math.max(1, value - 1))}
        >
          Previous
        </button>
        <button
          type="button"
          className="ov3-button is-quiet"
          disabled={page >= pageCount || directory.isFetching}
          onClick={() => setPage((value) => Math.min(pageCount, value + 1))}
        >
          Next
        </button>
      </div>
    </section>
  );
}
