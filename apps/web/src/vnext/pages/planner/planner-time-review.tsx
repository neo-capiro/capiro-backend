import { useEffect, useState } from 'react';
import { PLANNER_DEFAULT_TIME_REVIEW, type PlannerTimeReviewView } from '@capiro/strategy-verifier';
import {
  plannerError,
  usePlannerTimePreferences,
  usePlannerTimeReviewPages,
  usePlannerMutations,
} from './planner-api.js';
import { PlannerTimeExportButton } from './planner-time-export.js';

const hours = (n: number) =>
  `${(n / 60).toLocaleString(undefined, { maximumFractionDigits: 2 })} h`;
export function PlannerTimeReview({
  week,
  onSelect,
}: {
  week: string;
  onSelect: (userId: string) => void;
}) {
  const preferences = usePlannerTimePreferences(),
    mutations = usePlannerMutations();
  const [view, setView] = useState<PlannerTimeReviewView>(
    structuredClone(PLANNER_DEFAULT_TIME_REVIEW),
  );
  const [version, setVersion] = useState<number>(),
    [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState(''),
    [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!dirty && preferences.data && preferences.data.version >= (version ?? 0)) {
      setView(structuredClone(preferences.data.reviewView ?? PLANNER_DEFAULT_TIME_REVIEW));
      setVersion(preferences.data.version);
    }
  }, [preferences.data, dirty, version]);
  const query = usePlannerTimeReviewPages(
    week,
    view,
    version !== undefined && !preferences.isError,
  );
  const pages = query.data?.pages ?? [],
    first = pages[0];
  const stale = first && pages.some((p) => p.revision !== first.revision);
  const change = (patch: Partial<PlannerTimeReviewView>) => {
    if (patch.people && patch.people.length > 100) {
      setError(Error('Choose at most 100 people.'));
      return;
    }
    setView((old) => ({ ...old, ...patch }));
    setDirty(true);
    setMessage('');
    setError(null);
  };
  const unavailable = view.people.filter((id) => !first?.people.some((p) => p.id === id));
  const save = async () => {
    if (version === undefined) return;
    setError(null);
    setMessage('');
    try {
      const saved = await mutations.timePreferences.mutateAsync({ version, reviewView: view });
      setVersion(saved.version);
      setDirty(false);
      setMessage('Review view saved.');
    } catch (e) {
      setError(e);
    }
  };
  if (preferences.isError || query.isError || stale)
    return (
      <p role="alert" className="planner-error">
        {stale
          ? 'Time changed while loading. Refresh time review.'
          : plannerError(preferences.error ?? query.error)}
      </p>
    );
  return (
    <section className="planner-time-review" aria-label="Time review">
      <div className="planner-config-grid">
        <label className="planner-field">
          <span>People</span>
          <select
            aria-label="Review people"
            multiple
            value={view.people}
            disabled={!first}
            onChange={(e) =>
              change({ people: Array.from(e.target.selectedOptions, (o) => o.value) })
            }
          >
            {first?.people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {unavailable.map((id) => (
              <option key={id} value={id}>
                No longer assigned (saved)
              </option>
            ))}
          </select>
        </label>
        <label className="planner-field">
          <span>Status</span>
          <select
            aria-label="Review statuses"
            multiple
            value={view.statuses}
            onChange={(e) =>
              change({
                statuses: Array.from(
                  e.target.selectedOptions,
                  (o) => o.value as PlannerTimeReviewView['statuses'][number],
                ),
              })
            }
          >
            {['draft', 'submitted', 'approved', 'rejected'].map((s) => (
              <option key={s} value={s}>
                {s[0]!.toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <label className="planner-field">
          <span>Sort by</span>
          <select
            aria-label="Review sort"
            value={view.sort}
            onChange={(e) => change({ sort: e.target.value as PlannerTimeReviewView['sort'] })}
          >
            <option value="name">Alphabetical</option>
            <option value="total">Total time</option>
            <option value="billable">Billable time</option>
          </select>
        </label>
        <label className="planner-field">
          <span>Order</span>
          <select
            aria-label="Review order"
            value={view.direction}
            onChange={(e) =>
              change({ direction: e.target.value as PlannerTimeReviewView['direction'] })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>
      <p className="planner-muted">
        Empty people and status selections show all assigned submitters.
      </p>
      <div className="planner-actions">
        <PlannerTimeExportButton
          key={week}
          target={{ scope: 'review' }}
          week={week}
          label="Time logged by all submitters currently assigned to you. Review filters apply to the weekly table; this export uses its own date range."
        />
        <button type="button" onClick={() => change(structuredClone(PLANNER_DEFAULT_TIME_REVIEW))}>
          Clear filters
        </button>
        <button
          type="button"
          disabled={
            !dirty ||
            version === undefined ||
            view.people.length > 100 ||
            mutations.timePreferences.isPending
          }
          onClick={() => void save()}
        >
          Save review view
        </button>
      </div>
      {view.people.length > 100 && <p role="alert">Choose at most 100 people.</p>}
      {error != null && (
        <p role="alert" className="planner-error">
          {plannerError(error)}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!first ? (
        <p role="status">Loading time review…</p>
      ) : (
        <>
          <p>
            {first.matched} matching submitters · {hours(first.totalMinutes)} total ·{' '}
            {hours(first.billableMinutes)} billable
          </p>
          {!first.people.length ? (
            <p>No submitters are assigned to you for time review.</p>
          ) : (
            !first.matched && <p>No timesheets match these filters.</p>
          )}
          <div className="planner-table-scroll">
            <table className="planner-table">
              <thead>
                <tr>
                  <th>Submitter</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Billable</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {pages
                  .flatMap((p) => p.items)
                  .map((s) => (
                    <tr key={s.userId}>
                      <td>{first.people.find((p) => p.id === s.userId)?.name ?? 'Member'}</td>
                      <td>
                        {s.status}
                        {s.unavailableEntries ? ' · Some work unavailable' : ''}
                      </td>
                      <td>{hours(s.totalMinutes)}</td>
                      <td>{hours(s.billableMinutes)}</td>
                      <td>
                        <button type="button" onClick={() => onSelect(s.userId)}>
                          View timesheet
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {query.hasNextPage && (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              Load more submitters
            </button>
          )}
        </>
      )}
    </section>
  );
}
