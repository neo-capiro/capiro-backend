import { useEffect, useState } from 'react';
import type {
  DirectoryCommitteeStaffer,
} from '../../../pages/directory/directoryData.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import { useCommitteeStaffModel, type CommitteeStaffModel } from './useCommitteeStaffModel.js';

/**
 * Committee Staff (DIRECTORY-HANDOFF §7.2/§7.3).
 *
 * One route, one committee dataset, two peer views. The ROSTER is fully
 * source-backed today (`/api/directory/committees/:id/staff`). The HIERARCHY
 * canvas renders only what the source backs — committee, leadership (Chair /
 * Ranking Member are source-backed), and subcommittee units via parentOfficeId
 * — but per-unit staff placement, working-relationship edges and vacancies are
 * NOT modeled server-side (GAPS.md DIR-1/2/3). Those affordances ship disabled
 * with an explicit note, never synthesized.
 */

function committeeUnitLines(staffer: DirectoryCommitteeStaffer): { primary: string; secondary: string } {
  return {
    primary: staffer.committee?.name ?? '—',
    secondary: [staffer.committee?.chamber, staffer.isCurrent ? 'Current unit' : 'Former']
      .filter(Boolean)
      .join(' · '),
  };
}

export function CommitteeStaffVNext() {
  const model = useCommitteeStaffModel();
  return <CommitteeStaffVNextView model={model} />;
}

export function CommitteeStaffVNextView({ model }: { model: CommitteeStaffModel }) {
  const { search, view, committee, filters, results, selection } = model;
  const { total, staff, isInitialLoading, isRefetching } = results;

  return (
    <DirectoryShell
      eyebrow="Directory · Committee Staff"
      title="Committee Staff"
      subtitle="Committee & subcommittee staff · Hierarchy and roster · One canonical staff identity."
    >
      <div className="capiro-directory-toolbar">
        <div className="capiro-directory-search">
          <label className="capiro-directory-search__label" htmlFor="directory-committee-search">
            Search
          </label>
          <input
            id="directory-committee-search"
            className="capiro-directory-search__input"
            type="search"
            value={search.text}
            placeholder="Committee, staffer or unit…"
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
          label="Committee"
          options={committee.options}
          selected={committee.selectedId ? [committee.selectedId] : []}
          multiple={false}
          onChange={(next) => (next[0] ? committee.onSelect(next[0]) : undefined)}
        />
        <DirectoryFilterPill
          label="Chamber"
          options={filters.chamberOptions}
          selected={filters.chamber}
          multiple={false}
          onChange={(next) => filters.onChange('chamber', next)}
        />

        {/* Hierarchy / Roster peer toggle (radiogroup per §9.2). */}
        <div className="capiro-directory-viewtoggle" role="radiogroup" aria-label="View">
          <button
            type="button"
            role="radio"
            aria-checked={view.current === 'hierarchy'}
            className={`capiro-directory-viewtoggle__btn${
              view.current === 'hierarchy' ? ' capiro-directory-viewtoggle__btn--active' : ''
            }`}
            onClick={() => view.onChange('hierarchy')}
          >
            Hierarchy
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view.current === 'roster'}
            className={`capiro-directory-viewtoggle__btn${
              view.current === 'roster' ? ' capiro-directory-viewtoggle__btn--active' : ''
            }`}
            onClick={() => view.onChange('roster')}
          >
            Roster
          </button>
        </div>

        {filters.hasAny ? (
          <button type="button" className="capiro-directory-toolbar__reset" onClick={filters.onClearAll}>
            Clear all
          </button>
        ) : null}
      </div>

      {view.current === 'hierarchy' ? (
        <HierarchyView model={model} />
      ) : (
        <div className="capiro-directory-split">
          <div
            className={`capiro-directory-results capiro-directory-results--roster${
              isRefetching ? ' capiro-directory-results--refetching' : ''
            }`}
          >
            <div className="capiro-directory-results__header">
              <p className="capiro-directory-results__eyebrow">
                {committee.detail?.name ?? 'Committee Staff'}
              </p>
              <p className="capiro-directory-results__count">
                {isInitialLoading ? 'Loading…' : `${total} record${total === 1 ? '' : 's'}`}
              </p>
            </div>

            <div className="capiro-directory-columns capiro-directory-row-grid--roster">
              <p className="capiro-directory-columns__label">Staffer</p>
              <p className="capiro-directory-columns__label">Committee / Unit</p>
              <p className="capiro-directory-columns__label">Role</p>
              <p className="capiro-directory-columns__label">Contact</p>
              <p className="capiro-directory-columns__label" aria-hidden="true" />
            </div>

            {results.isError ? (
              <CapiroErrorState
                title="Committee staff could not be loaded"
                description="The committee-staff source did not respond."
                onRetry={results.onRetry}
              />
            ) : isInitialLoading ? (
              <>
                {Array.from({ length: 6 }, (_, index) => (
                  <div className="capiro-directory-row capiro-directory-row-grid--roster" key={index}>
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                  </div>
                ))}
              </>
            ) : staff.length === 0 ? (
              <CapiroEmptyState
                title={filters.hasAny ? 'No people match these filters' : 'No records in this source'}
                description={
                  filters.hasAny
                    ? 'Clear a filter or broaden the search to see more of the directory.'
                    : 'This committee has no staff on record.'
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
              staff.map((staffer) => {
                const unit = committeeUnitLines(staffer);
                const isSelected = staffer.id === selection.selectedId;
                return (
                  <button
                    type="button"
                    key={staffer.id}
                    aria-pressed={isSelected}
                    className={`capiro-directory-row capiro-directory-row-grid--roster${
                      isSelected ? ' capiro-directory-row--selected' : ''
                    }`}
                    onClick={() => selection.onToggle(staffer.id)}
                    onDoubleClick={() => selection.onOpenProfile(staffer.id)}
                  >
                    <span className="capiro-directory-cell capiro-directory-cell--identity">
                      <span className="capiro-directory-cell__primary">{staffer.fullName}</span>
                      <span className="capiro-directory-cell__secondary">{staffer.title || '—'}</span>
                    </span>
                    <span className="capiro-directory-cell capiro-directory-cell--mono">
                      <span className="capiro-directory-cell__primary">{unit.primary}</span>
                      <span className="capiro-directory-cell__secondary">{unit.secondary}</span>
                    </span>
                    <span className="capiro-directory-cell capiro-directory-cell--mono">
                      <span className="capiro-directory-cell__primary">{staffer.title || '—'}</span>
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
          </div>

          <SelectedCommitteeStaffRail
            staffer={selection.selected}
            onOpenProfile={selection.onOpenProfile}
          />
        </div>
      )}
    </DirectoryShell>
  );
}

/**
 * The hierarchy canvas renders only source-backed structure. Leadership
 * (Chair / Ranking Member) and subcommittee units are real; per-unit staff
 * placement, working-relationship edges and vacancies are not modeled
 * server-side (DIR-1/2/3) and ship as an explicit note, never synthesized.
 */
function HierarchyView({ model }: { model: CommitteeStaffModel }) {
  const { committee, results, selection } = model;
  const detail = committee.detail;

  return (
    <div className="capiro-directory-split">
      <div className="capiro-directory-hierarchy">
        <div className="capiro-directory-results__header">
          <p className="capiro-directory-results__eyebrow">
            {detail?.name ?? 'Committee'} · Hierarchy
          </p>
          <p className="capiro-directory-results__count">
            {results.isInitialLoading ? 'Loading…' : `${results.total} staff`}
          </p>
        </div>

        <div className="capiro-directory-legend">
          <span className="capiro-directory-legend__item">
            <span className="capiro-directory-legend__swatch capiro-directory-legend__swatch--solid" />
            Solid · formal committee structure
          </span>
          <span className="capiro-directory-legend__item capiro-directory-legend__item--disabled">
            <span className="capiro-directory-legend__swatch capiro-directory-legend__swatch--dashed" />
            Dashed blue · bipartisan / working relationship · not source-backed
          </span>
          <span className="capiro-directory-legend__item capiro-directory-legend__item--disabled">
            <span className="capiro-directory-legend__swatch capiro-directory-legend__swatch--muted" />
            Muted · unfilled / pending assignment · not source-backed
          </span>
        </div>

        {results.isInitialLoading ? (
          <CapiroSkeleton height={320} />
        ) : !detail ? (
          <CapiroEmptyState
            title="No committee selected"
            description="Choose a committee to see its structure."
          />
        ) : (
          <div className="capiro-directory-canvas">
            {/* Committee node (rounded-square mark — a place, never a person). */}
            <div className="capiro-directory-canvas__tier">
              <div className="capiro-directory-node capiro-directory-node--committee">
                <span className="capiro-directory-node__mark capiro-directory-node__mark--place">
                  {detail.committeeCode ?? detail.name.slice(0, 2).toUpperCase()}
                </span>
                <span className="capiro-directory-node__body">
                  <span className="capiro-directory-node__name">{detail.name}</span>
                  <span className="capiro-directory-node__meta">
                    {[detail.chamber, detail.kind].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </div>
            </div>

            {/* Leadership context (source-backed). Never an inferred reporting line. */}
            {detail.chair || detail.rankingMember ? (
              <div className="capiro-directory-canvas__tier">
                {detail.chair ? (
                  <LeadershipNode role="Committee Chair" memberRef={detail.chair} />
                ) : null}
                {detail.rankingMember ? (
                  <LeadershipNode role="Ranking Member" memberRef={detail.rankingMember} />
                ) : null}
              </div>
            ) : null}

            {/* Staff people, grouped at the committee level (per-unit placement
                is not source-backed — DIR-1). Selecting a node fills the rail. */}
            <div className="capiro-directory-canvas__tier capiro-directory-canvas__tier--staff">
              {results.staff.map((staffer) => {
                const isSelected = staffer.id === selection.selectedId;
                return (
                  <button
                    type="button"
                    key={staffer.id}
                    aria-pressed={isSelected}
                    className={`capiro-directory-node capiro-directory-node--person${
                      isSelected ? ' capiro-directory-node--selected' : ''
                    }`}
                    onClick={() => selection.onToggle(staffer.id)}
                    onDoubleClick={() => selection.onOpenProfile(staffer.id)}
                  >
                    <span className="capiro-directory-node__mark capiro-directory-node__mark--person">
                      {staffer.fullName
                        .split(/\s+/)
                        .filter(Boolean)
                        .map((p) => p[0])
                        .slice(0, 2)
                        .join('')
                        .toUpperCase()}
                    </span>
                    <span className="capiro-directory-node__body">
                      <span className="capiro-directory-node__name">{staffer.fullName}</span>
                      <span className="capiro-directory-node__meta">{staffer.title || '—'}</span>
                    </span>
                  </button>
                );
              })}
            </div>

            <p className="capiro-directory-canvas__note">
              Selecting a person node opens the staff profile rail. The highlighted path shows office
              placement; it does not imply a person-to-person reporting line unless the source
              explicitly supports it.
            </p>
          </div>
        )}
      </div>

      <SelectedCommitteeStaffRail staffer={selection.selected} onOpenProfile={selection.onOpenProfile} />
    </div>
  );
}

function LeadershipNode({
  role,
  memberRef,
}: {
  role: string;
  memberRef: { name?: string | null } | null;
}) {
  const name = memberRef?.name ?? null;
  return (
    <div className="capiro-directory-node capiro-directory-node--person capiro-directory-node--leader">
      <span className="capiro-directory-node__mark capiro-directory-node__mark--person">
        {(name ?? '?')
          .split(/\s+/)
          .filter(Boolean)
          .map((p) => p[0])
          .slice(0, 2)
          .join('')
          .toUpperCase()}
      </span>
      <span className="capiro-directory-node__body">
        <span className="capiro-directory-node__name">{name ?? 'Not recorded'}</span>
        <span className="capiro-directory-node__meta">{role}</span>
      </span>
    </div>
  );
}

function SelectedCommitteeStaffRail({
  staffer,
  onOpenProfile,
}: {
  staffer: DirectoryCommitteeStaffer | null;
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
          description="Choose a person to see contact and committee context."
        />
      </aside>
    );
  }

  const person = staffer;
  const unit = committeeUnitLines(person);

  async function copyEmail() {
    const email = person.email;
    if (!email) return;
    try {
      await navigator.clipboard.writeText(email);
      setCopyState('copied');
    } catch {
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

      <p className="capiro-directory-rail__office">{unit.primary}</p>
      <span className="capiro-directory-rail__divider" aria-hidden="true" />

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Committee / Unit</p>
        <p className="capiro-directory-field__value">{unit.primary}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Email</p>
        <p className="capiro-directory-field__value">{person.email || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Phone</p>
        <p className="capiro-directory-field__value">{person.phone || 'Not provided'}</p>
      </div>

      <div className="capiro-directory-rail__actions">
        <CapiroButton variant="primary" size="compact" onClick={() => onOpenProfile(person.id)}>
          Open full profile
        </CapiroButton>
        <CapiroButton size="compact" onClick={() => void copyEmail()} disabled={!person.email}>
          {copyState === 'copied' ? 'Email copied' : copyState === 'failed' ? 'Copy failed' : 'Copy email'}
        </CapiroButton>
      </div>
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
