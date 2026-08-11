import { useEffect, useState } from 'react';
import type { DirectoryStaffer } from '../../../pages/directory/directoryData.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import {
  useCongressionalStaffModel,
  type CongressionalStaffDetailModel,
  type CongressionalStaffModel,
} from './useCongressionalStaffModel.js';

/**
 * `/api/directory/staffers` accepts q, chamber, state, issue, page and pageSize —
 * verified against `directory.controller.ts`. There is deliberately no `role` or
 * `committee` parameter, so those two designed pills state that they are not
 * filterable yet instead of quietly filtering only the page in hand and
 * reporting a wrong result count.
 *
 * Neo has since ruled that both params should be added server-side; until that
 * lands, this honest state is what ships. See §6 of the Directory vNext handover.
 */
const UNFILTERABLE_NOTE =
  'Not filterable yet: the canonical staff directory endpoint does not accept this dimension. Search matches role and committee text in the meantime.';

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
  const model = useCongressionalStaffModel();
  return <CongressionalStaffVNextView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function CongressionalStaffVNextView({ model }: { model: CongressionalStaffModel }) {
  const { search, filters, results, pagination, selection } = model;
  const { total, staffers, isInitialLoading, isRefetching } = results;
  const { page, totalPages, pageSize } = pagination;

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
            value={search.text}
            placeholder="Name, role, member, issue or committee…"
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
          label="Chamber"
          options={filters.chamberOptions}
          selected={filters.chamber}
          multiple={false}
          onChange={(next) => filters.onChange('chamber', next)}
        />
        <DirectoryFilterPill
          label="State"
          options={filters.stateOptions}
          selected={filters.state}
          onChange={(next) => filters.onChange('state', next)}
        />
        <DirectoryFilterPill label="Role" options={[]} selected={[]} onChange={() => {}} unavailableReason={UNFILTERABLE_NOTE} />
        <DirectoryFilterPill
          label="Issue Area"
          options={filters.issueOptions}
          selected={filters.issue}
          onChange={(next) => filters.onChange('issue', next)}
        />
        <DirectoryFilterPill label="Committee" options={[]} selected={[]} onChange={() => {}} unavailableReason={UNFILTERABLE_NOTE} />

        {filters.hasAny ? (
          <button type="button" className="capiro-directory-toolbar__reset" onClick={filters.onClearAll}>
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

          {results.isError ? (
            <CapiroErrorState
              title="Congressional staff could not be loaded"
              description="The canonical staff directory did not respond."
              onRetry={results.onRetry}
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
              title={filters.hasAny ? 'No staff match these filters' : 'No congressional staff available'}
              description={
                filters.hasAny
                  ? 'Clear a filter or broaden the search to see more of the directory.'
                  : 'The canonical staff directory returned no records.'
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
            staffers.map((staffer) => {
              const office = officeLines(staffer);
              const coverage = coverageLines(staffer);
              const isSelected = staffer.id === selection.selectedId;
              return (
                <button
                  type="button"
                  key={staffer.id}
                  aria-pressed={isSelected}
                  className={`capiro-directory-row capiro-directory-row-grid${
                    isSelected ? ' capiro-directory-row--selected' : ''
                  }`}
                  onClick={() => selection.onToggle(staffer.id)}
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

        <SelectedStaffRail
          staffer={selection.selected}
          detail={selection.detail}
          onOpenProfile={selection.onOpenProfile}
        />
      </div>
    </DirectoryShell>
  );
}

function SelectedStaffRail({
  staffer,
  detail,
  onOpenProfile,
}: {
  staffer: DirectoryStaffer | null;
  detail: CongressionalStaffDetailModel;
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
              : (detail.committeeNames ?? 'None recorded')}
        </p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Source</p>
        <p className="capiro-directory-field__value">
          {detail.isLoading ? 'Loading…' : (detail.sourceSnapshotId ?? 'Provenance unavailable')}
        </p>
      </div>

      {detail.isError ? (
        <CapiroErrorState
          title="Profile detail unavailable"
          description="Contact and coverage above come from the list record."
          onRetry={detail.onRetry}
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
