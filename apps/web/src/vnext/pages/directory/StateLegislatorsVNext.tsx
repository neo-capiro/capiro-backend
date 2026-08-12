import type { StateLegislatorRow } from '../../../pages/directory/StateLegislatorDirectory.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { useStateLegislatorsModel, type StateLegModel } from './useStateLegislatorsModel.js';

/**
 * State Legislators (DIRECTORY-HANDOFF §7.5).
 *
 * Cards in a 3-up grid. The load-bearing rule is the stat strip: a count is a
 * number (render it), a real `0` (render `0`, muted), or `null` (never
 * crosswalked → "not available", warning ramp). A `?? 0` here is a bug.
 */

function chamberLabel(leg: StateLegislatorRow): string {
  return [leg.state, leg.chamber, leg.district ? `District ${leg.district}` : null]
    .filter(Boolean)
    .join(' · ');
}

/** A single stat cell: number, muted zero, or warning "not available". */
function StatCell({ label, value }: { label: string; value: number | null }) {
  if (value === null || value === undefined) {
    return (
      <div className="capiro-directory-stat capiro-directory-stat--unknown">
        <p className="capiro-directory-stat__value">Not available</p>
        <p className="capiro-directory-stat__label">{label}</p>
      </div>
    );
  }
  return (
    <div className={`capiro-directory-stat${value === 0 ? ' capiro-directory-stat--zero' : ''}`}>
      <p className="capiro-directory-stat__value">{value}</p>
      <p className="capiro-directory-stat__label">{label}</p>
    </div>
  );
}

export function StateLegislatorsVNext() {
  const model = useStateLegislatorsModel();
  return <StateLegislatorsVNextView model={model} />;
}

export function StateLegislatorsVNextView({ model }: { model: StateLegModel }) {
  const { search, filters, results, pagination, selection } = model;
  const { total, legislators, isInitialLoading, isRefetching } = results;
  const { page, totalPages, pageSize } = pagination;

  return (
    <DirectoryShell
      eyebrow="Directory · State Legislators"
      title="State Legislators"
      subtitle="Statehouse members · Committees · Sponsored bills · OpenStates + LegiScan-linked context."
    >
      <div className="capiro-directory-toolbar">
        <div className="capiro-directory-search">
          <label className="capiro-directory-search__label" htmlFor="directory-stateleg-search">
            Search
          </label>
          <input
            id="directory-stateleg-search"
            className="capiro-directory-search__input"
            type="search"
            value={search.text}
            placeholder="Name, state, chamber or district…"
            onChange={(event) => search.onChange(event.target.value)}
          />
          {search.text ? (
            <button
              type="button"
              className="capiro-directory-search__clear"
              onClick={() => search.onChange('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          ) : null}
        </div>

        <DirectoryFilterPill
          label="State"
          options={filters.stateOptions}
          selected={filters.state}
          onChange={(next) => filters.onChange('state', next)}
        />
        <DirectoryFilterPill
          label="Chamber"
          options={filters.chamberOptions}
          selected={filters.chamber}
          onChange={(next) => filters.onChange('chamber', next)}
        />
        <DirectoryFilterPill
          label="Party"
          options={filters.partyOptions}
          selected={filters.party}
          onChange={(next) => filters.onChange('party', next)}
        />

        {filters.hasAny ? (
          <button type="button" className="capiro-directory-toolbar__reset" onClick={filters.onClearAll}>
            Clear all
          </button>
        ) : null}
      </div>

      <div
        className={`capiro-directory-leg-section${isRefetching ? ' capiro-directory-results--refetching' : ''}`}
      >
        <div className="capiro-directory-results__header">
          <p className="capiro-directory-results__eyebrow">
            State Legislators · {isInitialLoading ? '…' : `${total} records`}
          </p>
          <p className="capiro-directory-results__count">Counts mirror API fields</p>
        </div>

        {results.isError ? (
          <CapiroErrorState
            title="State legislators could not be loaded"
            description="The OpenStates + LegiScan source did not respond."
            onRetry={results.onRetry}
          />
        ) : isInitialLoading ? (
          <div className="capiro-directory-leg-grid">
            {Array.from({ length: 6 }, (_, index) => (
              <CapiroSkeleton height={180} key={index} />
            ))}
          </div>
        ) : legislators.length === 0 ? (
          <CapiroEmptyState
            title={filters.hasAny ? 'No people match these filters' : 'No records in this source'}
            description={
              filters.hasAny
                ? 'Clear a filter or broaden the search to see more of the directory.'
                : 'The OpenStates source returned no records.'
            }
            action={
              filters.hasAny ? (
                <CapiroButton size="compact" onClick={filters.onClearAll}>
                  Clear filters
                </CapiroButton>
              ) : undefined
            }
          />
        ) : (
          <div className="capiro-directory-leg-grid" role="list">
            {legislators.map((leg) => {
              const isSelected = leg.id === selection.selectedId;
              return (
                <button
                  type="button"
                  role="listitem"
                  key={leg.id}
                  aria-pressed={isSelected}
                  className={`capiro-directory-leg-card${isSelected ? ' capiro-directory-leg-card--selected' : ''}`}
                  onClick={() => selection.onToggle(leg.id)}
                  onDoubleClick={() => selection.onOpenProfile(leg.id)}
                >
                  <div className="capiro-directory-leg-card__head">
                    <IdentityMark kind="person" size="md" name={leg.name} />
                    <div className="capiro-directory-leg-card__id">
                      <p className="capiro-directory-leg-card__name">{leg.name}</p>
                      <p className="capiro-directory-leg-card__meta">{chamberLabel(leg)}</p>
                    </div>
                  </div>
                  <p className="capiro-directory-leg-card__party">
                    <span
                      className={`capiro-directory-party-dot capiro-directory-party-dot--${(leg.party ?? '')
                        .slice(0, 1)
                        .toLowerCase()}`}
                      aria-hidden="true"
                    />
                    {leg.party || 'Party —'}
                  </p>
                  <div className="capiro-directory-leg-card__stats">
                    <StatCell label="Bills" value={leg.billCount} />
                    <StatCell label="Enacted" value={leg.enactedCount} />
                    <StatCell label="Committees" value={leg.committeeCount} />
                  </div>
                  <div className="capiro-directory-leg-card__foot">
                    <span
                      className={
                        leg.email
                          ? 'capiro-directory-leg-card__email'
                          : 'capiro-directory-leg-card__email capiro-directory-leg-card__email--none'
                      }
                    >
                      {leg.email || 'No email'}
                    </span>
                    <span className="capiro-directory-cell__action" aria-hidden="true">
                      Open profile →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {total > pageSize ? (
          <div className="capiro-directory-pagination">
            <CapiroButton
              size="compact"
              disabled={page <= 1}
              onClick={() => pagination.onPageChange(page - 1)}
            >
              Previous
            </CapiroButton>
            <p className="capiro-directory-pagination__status">
              Page {Math.min(page, totalPages)} of {totalPages}
            </p>
            <CapiroButton
              size="compact"
              disabled={page >= totalPages}
              onClick={() => pagination.onPageChange(page + 1)}
            >
              Next
            </CapiroButton>
          </div>
        ) : null}
      </div>
    </DirectoryShell>
  );
}
