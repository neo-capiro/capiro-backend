import { useEffect, useState } from 'react';
import type {
  StateLegislatorDetail,
  StateLegislatorRow,
} from '../../../pages/directory/StateLegislatorDirectory.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { useStateLegislatorsModel, type StateLegDetailModel, type StateLegModel } from './useStateLegislatorsModel.js';

/**
 * State Legislators (DIRECTORY-HANDOFF §7.5).
 *
 * Cards in a 3-up grid. The load-bearing rule is the stat strip: a count is a
 * number (render it), a real `0` (render `0`, muted), or `null` (never
 * crosswalked → "not available", warning ramp). A `?? 0` here is a bug.
 */

/** 'upper'/'lower' -> 'Senate'/'House' — same transform the canonical
 * StateLegislatorDirectory.tsx already applies; the vNext port had been
 * passing the raw code straight through (confirmed live: cards showed
 * "LOWER" instead of "House"). */
function chamberName(chamber: string | null): string | null {
  if (chamber === 'upper') return 'Senate';
  if (chamber === 'lower') return 'House';
  return chamber;
}

function chamberLabel(leg: StateLegislatorRow): string {
  return [leg.state, chamberName(leg.chamber), leg.district ? `District ${leg.district}` : null]
    .filter(Boolean)
    .join(' · ');
}

/**
 * A single stat cell: number, muted zero, or unknown. The unknown case still
 * never fabricates a 0 — it renders a muted "—" at the number's own position
 * (not the literal words "Not available" stuffed into a number-sized slot,
 * which is what wrapped to two ugly lines in production) and demotes the
 * explanation into the label itself, so the tri-state stays visible from the
 * card's colour treatment (kept on `--unknown`) rather than from the glyph.
 */
function StatCell({ label, value }: { label: string; value: number | null }) {
  if (value === null || value === undefined) {
    return (
      <div className="capiro-directory-stat capiro-directory-stat--unknown">
        <p className="capiro-directory-stat__value" aria-hidden="true">—</p>
        <p className="capiro-directory-stat__label">
          {label} <span className="capiro-directory-stat__unknown-note">not available</span>
        </p>
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

function formatSyncedDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

      <div className="capiro-directory-split">
      <div
        className={`capiro-directory-results capiro-directory-leg-section${isRefetching ? ' capiro-directory-results--refetching' : ''}`}
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
                    <IdentityMark kind="person" size="md" name={leg.name} imageUrl={leg.image} />
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

      <SelectedLegislatorRail
        legislator={selection.selected}
        detail={selection.detail}
        onOpenProfile={selection.onOpenProfile}
      />
      </div>
    </DirectoryShell>
  );
}

function SelectedLegislatorRail({
  legislator,
  detail,
  onOpenProfile,
}: {
  legislator: StateLegislatorRow | null;
  detail: StateLegDetailModel;
  onOpenProfile: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [legislator?.id]);

  if (!legislator) {
    return (
      <aside className="capiro-directory-rail" aria-label="Selected legislator">
        <p className="capiro-directory-rail__eyebrow">Selected legislator</p>
        <CapiroEmptyState
          title="No one selected"
          description="Choose a legislator to see contact and bill activity."
        />
      </aside>
    );
  }

  const record: StateLegislatorRow = legislator;
  const detailData: StateLegislatorDetail | null = detail.detail;
  const website = detailData?.url;
  const synced = formatSyncedDate(detailData?.syncedAt);

  async function copyEmail() {
    const email = record.email;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <aside className="capiro-directory-rail" aria-label="Selected legislator">
      <p className="capiro-directory-rail__eyebrow">Selected legislator</p>

      <IdentityMark
        kind="person"
        size="lg"
        name={record.name}
        imageUrl={record.image}
        metadata={chamberLabel(record)}
        metadataVisible
      />

      <p className="capiro-directory-rail__office">{chamberLabel(record)}</p>

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Email</p>
        <p className="capiro-directory-field__value">{record.email || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Website</p>
        <p className="capiro-directory-field__value">
          {detail.isLoading ? 'Loading…' : website || 'Not provided'}
        </p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Party</p>
        <p className="capiro-directory-field__value">
          {[record.party, detailData ? (detailData.active ? 'Active' : 'Inactive') : null]
            .filter(Boolean)
            .join(' · ') || 'Not recorded'}
        </p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Bills</p>
        <p className="capiro-directory-field__value">
          {record.billCount === null
            ? 'Not available'
            : `${record.billCount} sponsored${record.enactedCount !== null ? ` · ${record.enactedCount} enacted` : ''}`}
        </p>
      </div>
      {synced ? (
        <div className="capiro-directory-field">
          <p className="capiro-directory-field__label">Synced</p>
          <p className="capiro-directory-field__value">{synced}</p>
        </div>
      ) : null}

      {detail.isError ? (
        <CapiroErrorState
          title="Legislator detail unavailable"
          description="List data above comes from the record."
          onRetry={detail.onRetry}
        />
      ) : null}

      <div className="capiro-directory-rail__actions">
        <CapiroButton variant="primary" size="compact" onClick={() => onOpenProfile(record.id)}>
          Open full profile
        </CapiroButton>
        <CapiroButton size="compact" onClick={() => void copyEmail()} disabled={!record.email}>
          {copyState === 'copied' ? 'Email copied' : copyState === 'failed' ? 'Copy failed' : 'Copy email'}
        </CapiroButton>
      </div>
      <p className="capiro-directory-field__label" role="status" aria-live="polite">
        {copyState === 'copied' ? 'Email copied to clipboard' : copyState === 'failed' ? 'Clipboard unavailable' : ''}
      </p>
    </aside>
  );
}
