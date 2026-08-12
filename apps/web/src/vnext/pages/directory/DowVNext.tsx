import { useEffect, useState } from 'react';
import type {
  AcquisitionPersonnelDetail,
  AcquisitionPersonnelListItem,
} from '../../../pages/program-element/types.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { useDowModel, type DowDetailModel, type DowModel } from './useDowModel.js';

/** Provenance confidence → the display ramp. Never invented — only mapped. */
function confidenceBand(value: number): { label: 'HIGH' | 'MEDIUM' | 'LOW'; tone: 'success' | 'warning' | 'neutral' } {
  if (value >= 0.95) return { label: 'HIGH', tone: 'success' };
  if (value >= 0.8) return { label: 'MEDIUM', tone: 'warning' };
  return { label: 'LOW', tone: 'neutral' };
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Program-alignment cell: PE codes when aligned, the source string otherwise. */
function alignmentLines(person: AcquisitionPersonnelListItem): { primary: string; aligned: boolean } {
  const codes = [person.pePrimary, ...(person.peSecondary ?? [])].filter(
    (v): v is string => Boolean(v),
  );
  if (codes.length) {
    return { primary: codes.map((c) => `PE ${c}`).join(' · '), aligned: true };
  }
  // Never upgrade "program-office alignment" into a fabricated PE code (§7.4).
  return { primary: person.organization ? 'Program-office alignment' : 'Source-backed when available', aligned: false };
}

export function DowVNext() {
  const model = useDowModel();
  return <DowVNextView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function DowVNextView({ model }: { model: DowModel }) {
  const { search, filters, results, pagination, selection } = model;
  const { total, persons, isInitialLoading, isRefetching } = results;
  const { page, totalPages, pageSize } = pagination;

  return (
    <DirectoryShell
      eyebrow="Directory · Department of War"
      title="Department of War"
      subtitle="Acquisition leadership & program officials · PEO / PM / KO / technical roles · PE-aligned."
    >
      <div className="capiro-directory-toolbar">
        <div className="capiro-directory-search">
          <label className="capiro-directory-search__label" htmlFor="directory-dow-search">
            Search
          </label>
          <input
            id="directory-dow-search"
            className="capiro-directory-search__input"
            type="search"
            value={search.text}
            placeholder="Name, office, program, PEO or Program Element…"
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
          label="PE alignment"
          options={filters.peOptions}
          selected={filters.pe}
          multiple={false}
          onChange={(next) => filters.onChange('pe', next)}
        />
        <DirectoryFilterPill
          label="Service"
          options={filters.serviceOptions}
          selected={filters.service}
          multiple={false}
          onChange={(next) => filters.onChange('service', next)}
        />
        <DirectoryFilterPill
          label="Role"
          options={filters.roleOptions}
          selected={filters.role}
          multiple={false}
          onChange={(next) => filters.onChange('role', next)}
        />
        <DirectoryFilterPill
          label="Organization"
          options={filters.orgOptions}
          selected={filters.org}
          multiple={false}
          onChange={(next) => filters.onChange('org', next)}
        />

        {filters.hasAny ? (
          <button type="button" className="capiro-directory-toolbar__reset" onClick={filters.onClearAll}>
            Clear all
          </button>
        ) : null}
      </div>

      <div className="capiro-directory-split">
        <div
          className={`capiro-directory-results capiro-directory-results--dow${
            isRefetching ? ' capiro-directory-results--refetching' : ''
          }`}
        >
          <div className="capiro-directory-results__header">
            <p className="capiro-directory-results__eyebrow">Acquisition Personnel</p>
            <p className="capiro-directory-results__count">
              {isInitialLoading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
            </p>
          </div>

          <div className="capiro-directory-columns capiro-directory-row-grid--dow">
            <p className="capiro-directory-columns__label">Person</p>
            <p className="capiro-directory-columns__label">Role</p>
            <p className="capiro-directory-columns__label">Organization</p>
            <p className="capiro-directory-columns__label">Service</p>
            <p className="capiro-directory-columns__label">Program Alignment</p>
            <p className="capiro-directory-columns__label" aria-hidden="true" />
          </div>

          {results.isError ? (
            <CapiroErrorState
              title="Acquisition personnel could not be loaded"
              description="The acquisition-personnel source did not respond."
              onRetry={results.onRetry}
            />
          ) : isInitialLoading ? (
            <>
              {Array.from({ length: 6 }, (_, index) => (
                <div className="capiro-directory-row capiro-directory-row-grid--dow" key={index}>
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                  <CapiroSkeleton height={48} />
                </div>
              ))}
            </>
          ) : persons.length === 0 ? (
            <CapiroEmptyState
              title={filters.hasAny ? 'No people match these filters' : 'No records in this source'}
              description={
                filters.hasAny
                  ? 'Clear a filter or broaden the search to see more of the directory.'
                  : 'The acquisition-personnel source returned no records.'
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
            persons.map((person) => {
              const alignment = alignmentLines(person);
              const isSelected = person.id === selection.selectedId;
              return (
                <button
                  type="button"
                  key={person.id}
                  aria-pressed={isSelected}
                  className={`capiro-directory-row capiro-directory-row-grid--dow${
                    isSelected ? ' capiro-directory-row--selected' : ''
                  }`}
                  onClick={() => selection.onToggle(person.id)}
                >
                  <span className="capiro-directory-cell capiro-directory-cell--identity">
                    <span className="capiro-directory-cell__primary">{person.fullName}</span>
                    <span className="capiro-directory-cell__secondary">{person.title || '—'}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{person.title || '—'}</span>
                    <span className="capiro-directory-cell__secondary">{person.role || '—'}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{person.organization || '—'}</span>
                    <span className="capiro-directory-cell__secondary">
                      {person.pePrimary ? `PE ${person.pePrimary}` : ''}
                    </span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{person.service || '—'}</span>
                    <span className="capiro-directory-cell__secondary">{person.status || ''}</span>
                  </span>
                  <span
                    className={`capiro-directory-cell capiro-directory-cell--mono${
                      alignment.aligned ? '' : ' capiro-directory-cell--muted'
                    }`}
                  >
                    <span className="capiro-directory-cell__primary">{alignment.primary}</span>
                    <span className="capiro-directory-cell__secondary">
                      {person.sourceCount ? `${person.sourceCount} source${person.sourceCount === 1 ? '' : 's'}` : ''}
                    </span>
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

        <SelectedDowRail
          person={selection.selected}
          detail={selection.detail}
          onOpenProfile={selection.onOpenProfile}
        />
      </div>
    </DirectoryShell>
  );
}

function SelectedDowRail({
  person,
  detail,
  onOpenProfile,
}: {
  person: AcquisitionPersonnelListItem | null;
  detail: DowDetailModel;
  onOpenProfile: (id: string) => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [person?.id]);

  if (!person) {
    return (
      <aside className="capiro-directory-rail" aria-label="Selected official">
        <p className="capiro-directory-rail__eyebrow">Selected official</p>
        <CapiroEmptyState
          title="No one selected"
          description="Choose a row to see role, organization and provenance."
        />
      </aside>
    );
  }

  const record: AcquisitionPersonnelListItem = person;
  const alignment = alignmentLines(record);
  const band = confidenceBand(record.confidence);
  const firstSeen = formatDate(record.firstSeenAt);
  const lastSeen = formatDate(record.lastSeenAt);
  const detailData: AcquisitionPersonnelDetail | null = detail.detail;

  async function copyContact() {
    const value = record.publicProfileUrl ?? record.emailDomain;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <aside className="capiro-directory-rail" aria-label="Selected official">
      <p className="capiro-directory-rail__eyebrow">Selected official</p>

      <IdentityMark
        kind="person"
        size="lg"
        name={record.fullName}
        metadata={record.title ?? undefined}
        metadataVisible
      />

      <p className="capiro-directory-rail__office">{record.organization || 'Organization not recorded'}</p>
      <span className="capiro-directory-rail__divider" aria-hidden="true" />

      <div className="capiro-directory-callout">
        <p className="capiro-directory-callout__label">Program alignment</p>
        <p className="capiro-directory-callout__value">{alignment.primary}</p>
      </div>

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Service</p>
        <p className="capiro-directory-field__value">{record.service || 'Not recorded'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Role</p>
        <p className="capiro-directory-field__value">{record.role || 'Not recorded'}</p>
      </div>

      {/* Provenance: displayed, never invented. Each line is absent when the
          source did not supply it. */}
      <div className="capiro-directory-provenance">
        <p className="capiro-directory-provenance__eyebrow">Provenance</p>
        <div className="capiro-directory-field">
          <p className="capiro-directory-field__label">Confidence</p>
          <p className="capiro-directory-field__value">
            <CapiroBadge tone={band.tone}>{band.label}</CapiroBadge>
          </p>
        </div>
        {firstSeen ? (
          <div className="capiro-directory-field">
            <p className="capiro-directory-field__label">First seen</p>
            <p className="capiro-directory-field__value">{firstSeen}</p>
          </div>
        ) : null}
        {lastSeen ? (
          <div className="capiro-directory-field">
            <p className="capiro-directory-field__label">Last seen</p>
            <p className="capiro-directory-field__value">{lastSeen}</p>
          </div>
        ) : null}
        {detail.isLoading ? (
          <p className="capiro-directory-field__label">Loading sources…</p>
        ) : detailData?.sources?.length ? (
          <div className="capiro-directory-field">
            <p className="capiro-directory-field__label">Sources</p>
            <p className="capiro-directory-field__value">
              {detailData.sources
                .map((s) => s.source)
                .filter(Boolean)
                .slice(0, 3)
                .join(' · ')}
            </p>
          </div>
        ) : null}
      </div>

      {detail.isError ? (
        <CapiroErrorState
          title="Provenance detail unavailable"
          description="List provenance above comes from the record."
          onRetry={detail.onRetry}
        />
      ) : null}

      <div className="capiro-directory-rail__actions">
        <CapiroButton variant="primary" size="compact" onClick={() => onOpenProfile(record.id)}>
          Open full profile
        </CapiroButton>
        <CapiroButton
          size="compact"
          onClick={() => void copyContact()}
          disabled={!record.publicProfileUrl && !record.emailDomain}
        >
          {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy'}
        </CapiroButton>
      </div>
      <p className="capiro-directory-field__label" role="status" aria-live="polite">
        {copyState === 'copied' ? 'Contact copied to clipboard' : copyState === 'failed' ? 'Clipboard unavailable' : ''}
      </p>
    </aside>
  );
}
