import { useEffect, useState } from 'react';
import type { DirectoryEntry, DirectoryStaffMember } from '../../../pages/directory/directoryData.js';
import { DirectoryMemberProfileModal } from '../../../pages/directory/DirectoryMemberProfileModal.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState, CapiroErrorState, CapiroSkeleton } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import { DirectoryShell } from './DirectoryShell.js';
import { DirectoryFilterPill } from './DirectoryFilterPill.js';
import {
  useCongressionalStaffModel,
  type CongressionalOfficeRow,
  type CongressionalSelection,
  type CongressionalStaffDetailModel,
  type CongressionalStaffModel,
} from './useCongressionalStaffModel.js';

/**
 * A member's seat, e.g. `VA-10` for a representative and `OH` for a senator —
 * senators have no district, and printing `OH-` for them would invent one.
 */
function seatLabel(member: Pick<DirectoryEntry, 'state' | 'district'>): string {
  return [member.state, member.district].filter(Boolean).join('-');
}

/**
 * The line under a member's name. Outreach labels it the same way: a leadership
 * title outranks the generic "Member of Congress" when the member holds one.
 * (The endpoint already resolves `title` in that order, so the two agree; the
 * expression is kept explicit because the precedence is the point.) The last
 * fallback mirrors the endpoint's own default rather than assuming the House
 * one — a senator labelled "Member of Congress" would simply be wrong.
 */
function memberRoleLabel(member: DirectoryEntry): string {
  return (
    member.leadershipPositions[0] ||
    member.title ||
    (member.chamber === 'Senate'
      ? 'United States Senator'
      : member.chamber === 'Governor'
        ? 'Governor'
        : 'Member of Congress')
  );
}

/** Office column for a member row: the office label over chamber/seat/party. */
function memberOfficeLines(member: DirectoryEntry): { primary: string; secondary: string } {
  const seat = seatLabel(member);
  return {
    primary: member.office || member.officeLocation || '—',
    secondary: [member.chamber, seat, member.partyName].filter(Boolean).join(' · ') || '—',
  };
}

/** Office column for a staffer row: where they sit, and whose office it is. */
function staffOfficeLines(
  staff: DirectoryStaffMember,
  member: DirectoryEntry,
): { primary: string; secondary: string } {
  const seat = seatLabel(member);
  return {
    primary: staff.officeLocation || member.officeLocation || 'Personal office',
    secondary: [`Staff to ${member.fullName}`, seat].filter(Boolean).join(' · '),
  };
}

/** Coverage reads issue areas first, then roles; both are per-row API fields. */
function coverageLines(staff: DirectoryStaffMember): { primary: string; secondary: string } {
  const issues = staff.issueAreas.filter(Boolean);
  const roles = staff.roles.filter(Boolean);
  return {
    primary: issues.length ? issues.slice(0, 2).join(' · ') : '—',
    secondary: roles.length ? roles.slice(0, 2).join(' · ') : 'No coverage recorded',
  };
}

/** Committee column for a member row: their committees over the roster size. */
function memberCommitteeLines(office: CongressionalOfficeRow): { primary: string; secondary: string } {
  const committees = office.member.committees.filter(Boolean);
  const shown = office.staff.length;
  const held = office.staffTotal;
  return {
    primary: committees.length ? committees.slice(0, 2).join(' · ') : 'No committee recorded',
    secondary:
      held === 0
        ? 'No staff synced'
        : shown === held
          ? `${held} staff`
          : // The office qualified on a matching staffer, so say how much of the
            // roster the filters are hiding rather than implying it is the whole.
            `${shown} of ${held} staff match`,
  };
}

export function CongressionalStaffVNext() {
  const model = useCongressionalStaffModel();
  return <CongressionalStaffVNextView model={model} />;
}

/** Presentation half, kept data-free so the visual harness can render it. */
export function CongressionalStaffVNextView({ model }: { model: CongressionalStaffModel }) {
  const { search, filters, results, pagination, selection } = model;
  const { total, staffTotal, offices, isInitialLoading, isRefetching } = results;
  const { page, totalPages, pageSize } = pagination;

  // A staffer has no equivalent on canonical's own Directory list — clicking
  // one there only ever navigates to the plain staff page, so `onOpenProfile`
  // (below) already matches it. A member does have a richer equivalent: the
  // same 7-tab modal canonical opens from its own list. `open` is derived from
  // the current selection, not just this flag, so switching to a staffer or
  // clearing the selection closes it automatically — the same thing canonical
  // gets for free from tying its own modal to `selectedEntry !== null`.
  const [memberProfileOpen, setMemberProfileOpen] = useState(false);

  return (
    <DirectoryShell
      eyebrow="Directory · Congressional Staff"
      title="Congressional Staff"
      subtitle="Members and their personal-office staff · Federal House & Senate · Searchable by role, issue and member."
    >
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
        {/* Role and Committee were inert placeholders while this list read
            `/api/directory/staffers`, which accepts neither — the DIR-8 gap.
            Reading offices from `/api/directory/contacts`, which now answers
            both from the office's own roster, makes them real filters. */}
        <DirectoryFilterPill
          label="Role"
          options={filters.roleOptions}
          selected={filters.role}
          onChange={(next) => filters.onChange('role', next)}
        />
        <DirectoryFilterPill
          label="Issue Area"
          options={filters.issueOptions}
          selected={filters.issue}
          onChange={(next) => filters.onChange('issue', next)}
        />
        <DirectoryFilterPill
          label="Committee"
          options={filters.committeeOptions}
          selected={filters.committee}
          onChange={(next) => filters.onChange('committee', next)}
        />

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
            {/* Offices are what this list pages through, so they are what it
                counts. `totals.staff` is computed once when the directory is
                cached and never moves with the query, so it is stated as the
                directory total rather than sat beside a filtered count as if
                it were one. */}
            <p className="capiro-directory-results__count">
              {isInitialLoading ? 'Loading…' : `${total} office${total === 1 ? '' : 's'}`}
            </p>
            {!isInitialLoading && staffTotal ? (
              <p className="capiro-directory-results__note">{`${staffTotal} staff in directory`}</p>
            ) : null}
            {offices.length ? (
              <button
                type="button"
                className="capiro-directory-results__expand"
                onClick={results.allExpanded ? results.onCollapseAll : results.onExpandAll}
              >
                {results.allExpanded ? 'Collapse all' : 'Expand all'}
              </button>
            ) : null}
          </div>

          <div className="capiro-directory-columns capiro-directory-hierarchy-grid">
            <p className="capiro-directory-columns__label" aria-hidden="true" />
            <div className="capiro-directory-row-grid">
              <p className="capiro-directory-columns__label">Office / Person</p>
              <p className="capiro-directory-columns__label">Office</p>
              <p className="capiro-directory-columns__label">Committee &amp; Coverage</p>
              <p className="capiro-directory-columns__label">Contact</p>
              <p className="capiro-directory-columns__label" aria-hidden="true" />
            </div>
          </div>

          {results.isError ? (
            <CapiroErrorState
              title="Congressional staff could not be loaded"
              description="The canonical directory did not respond."
              onRetry={results.onRetry}
            />
          ) : isInitialLoading ? (
            <>
              {Array.from({ length: 6 }, (_, index) => (
                <div className="capiro-directory-row capiro-directory-hierarchy-grid" key={index}>
                  <CapiroSkeleton height={48} />
                  <div className="capiro-directory-row-grid">
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                    <CapiroSkeleton height={48} />
                  </div>
                </div>
              ))}
            </>
          ) : offices.length === 0 ? (
            <CapiroEmptyState
              title={filters.hasAny ? 'No offices match these filters' : 'No congressional offices available'}
              description={
                filters.hasAny
                  ? 'Clear a filter or broaden the search to see more of the directory.'
                  : 'The canonical directory returned no records.'
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
            offices.map((office) => (
              <OfficeRows
                key={office.member.id}
                office={office}
                selectedId={selection.selectedId}
                onToggleExpand={results.onToggleExpand}
                onToggleSelect={selection.onToggle}
              />
            ))
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

        <SelectedProfileRail
          selection={selection.selected}
          detail={selection.detail}
          onOpenProfile={selection.onOpenProfile}
          onOpenMemberProfile={() => setMemberProfileOpen(true)}
        />
      </div>

      <DirectoryMemberProfileModal
        entry={selection.selected?.kind === 'member' ? selection.selected.member : null}
        open={memberProfileOpen && selection.selected?.kind === 'member'}
        onClose={() => setMemberProfileOpen(false)}
      />
    </DirectoryShell>
  );
}

/**
 * One office and, when expanded, its roster — the member→staffer organisation
 * the Outreach recipient picker uses. The caret and the row body are separate
 * buttons rather than one nested inside the other: expanding an office and
 * selecting it are different actions, and a button cannot legally contain
 * another button.
 */
function OfficeRows({
  office,
  selectedId,
  onToggleExpand,
  onToggleSelect,
}: {
  office: CongressionalOfficeRow;
  selectedId: string | null;
  onToggleExpand: (memberId: string) => void;
  onToggleSelect: (id: string) => void;
}) {
  const { member, staff, isExpanded } = office;
  const rosterId = `roster-${member.id}`;
  const officeLines = memberOfficeLines(member);
  const committeeLines = memberCommitteeLines(office);
  const isSelected = member.id === selectedId;
  const memberRole = memberRoleLabel(member);

  return (
    <>
      <div
        className={`capiro-directory-row capiro-directory-row--office capiro-directory-hierarchy-grid${
          isSelected ? ' capiro-directory-row--selected' : ''
        }`}
      >
        <button
          type="button"
          className="capiro-directory-caret"
          aria-expanded={isExpanded}
          aria-controls={rosterId}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} staff for ${member.fullName}`}
          onClick={() => onToggleExpand(member.id)}
        >
          <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span>
        </button>

        <button
          type="button"
          aria-pressed={isSelected}
          className="capiro-directory-row__select capiro-directory-row-grid"
          onClick={() => onToggleSelect(member.id)}
        >
          <span className="capiro-directory-cell capiro-directory-cell--person">
            {/* Decorative here: the name it would announce is the very next
                thing in the row, and a doubled name is noise to a screen
                reader. */}
            <IdentityMark
              kind="person"
              size="sm"
              name={member.fullName}
              imageUrl={member.photoUrl || null}
              aria-hidden="true"
            />
            <span className="capiro-directory-cell__stack">
              <span className="capiro-directory-cell__primary">{member.fullName}</span>
              <span className="capiro-directory-cell__secondary">{memberRole}</span>
            </span>
          </span>
          <span className="capiro-directory-cell capiro-directory-cell--mono">
            <span className="capiro-directory-cell__primary">{officeLines.primary}</span>
            <span className="capiro-directory-cell__secondary">{officeLines.secondary}</span>
          </span>
          <span className="capiro-directory-cell capiro-directory-cell--mono">
            <span className="capiro-directory-cell__primary">{committeeLines.primary}</span>
            <span className="capiro-directory-cell__secondary">{committeeLines.secondary}</span>
          </span>
          <span className="capiro-directory-cell capiro-directory-cell--mono capiro-directory-cell--contact">
            <span className="capiro-directory-cell__primary">{member.email || 'No email'}</span>
            <span className="capiro-directory-cell__secondary">{member.phone || 'No phone'}</span>
          </span>
          <span className="capiro-directory-cell">
            <span className="capiro-directory-cell__action" aria-hidden="true">
              Open →
            </span>
          </span>
        </button>
      </div>

      <div id={rosterId} className="capiro-directory-roster" hidden={!isExpanded}>
        {staff.length === 0 ? (
          <p className="capiro-directory-roster__empty">
            {office.staffTotal === 0
              ? 'No staffer contacts synced for this office.'
              : 'No staffer in this office matches the current Role and Issue Area filters.'}
          </p>
        ) : (
          staff.map((person) => {
            const coverage = coverageLines(person);
            const staffOffice = staffOfficeLines(person, member);
            const staffSelected = person.id === selectedId;
            return (
              <div
                key={person.id}
                className={`capiro-directory-row capiro-directory-row--staff capiro-directory-hierarchy-grid${
                  staffSelected ? ' capiro-directory-row--selected' : ''
                }`}
              >
                <span className="capiro-directory-branch" aria-hidden="true" />
                <button
                  type="button"
                  aria-pressed={staffSelected}
                  className="capiro-directory-row__select capiro-directory-row-grid"
                  onClick={() => onToggleSelect(person.id)}
                >
                  <span className="capiro-directory-cell capiro-directory-cell--person">
                    {/* Staff photos are null on the list contract and a staffer is
                        never given their member's headshot, so initials stand. */}
                    <IdentityMark kind="person" size="sm" name={person.fullName} aria-hidden="true" />
                    <span className="capiro-directory-cell__stack">
                      <span className="capiro-directory-cell__primary">{person.fullName}</span>
                      <span className="capiro-directory-cell__secondary">{person.title || 'Staffer'}</span>
                    </span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{staffOffice.primary}</span>
                    <span className="capiro-directory-cell__secondary">{staffOffice.secondary}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono">
                    <span className="capiro-directory-cell__primary">{coverage.primary}</span>
                    <span className="capiro-directory-cell__secondary">{coverage.secondary}</span>
                  </span>
                  <span className="capiro-directory-cell capiro-directory-cell--mono capiro-directory-cell--contact">
                    <span className="capiro-directory-cell__primary">{person.email || 'No email'}</span>
                    <span className="capiro-directory-cell__secondary">{person.phone || 'No phone'}</span>
                  </span>
                  <span className="capiro-directory-cell">
                    <span className="capiro-directory-cell__action" aria-hidden="true">
                      Open →
                    </span>
                  </span>
                </button>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function SelectedProfileRail({
  selection,
  detail,
  onOpenProfile,
  onOpenMemberProfile,
}: {
  selection: CongressionalSelection | null;
  detail: CongressionalStaffDetailModel;
  /** Staff: navigates to the canonical staff page — canonical has no richer equivalent. */
  onOpenProfile: (selection: CongressionalSelection) => void;
  /** Member: opens the same 7-tab modal canonical's own list uses. */
  onOpenMemberProfile: () => void;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    setCopyState('idle');
  }, [selection?.id]);

  if (!selection) {
    return (
      <aside className="capiro-directory-rail" aria-label="Selected directory profile">
        <p className="capiro-directory-rail__eyebrow">Selected directory profile</p>
        <CapiroEmptyState
          title="No one selected"
          description="Choose a member or a staffer to see contact, coverage and committee context."
        />
      </aside>
    );
  }

  const isMember = selection.kind === 'member';
  const name = isMember ? selection.member.fullName : selection.staff.fullName;
  const role = isMember ? memberRoleLabel(selection.member) : selection.staff.title;
  const email = isMember ? selection.member.email : selection.staff.email;
  const phone = isMember ? selection.member.phone : selection.staff.phone;
  const coverage = isMember
    ? selection.member.focusAreas.slice(0, 3).join(' · ') || 'No coverage recorded'
    : coverageLines(selection.staff).primary;
  const officeLine = isMember
    ? memberOfficeLines(selection.member).primary
    : `Office of ${selection.member.fullName}`;

  async function copyEmail() {
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
    <aside className="capiro-directory-rail" aria-label="Selected directory profile">
      <p className="capiro-directory-rail__eyebrow">
        {isMember ? 'Selected member profile' : 'Selected staff profile'}
      </p>

      {/* A member's photo rides on their list row; a staffer's exists only on
          the detail contract, which the rail is already fetching. Either way an
          absent one falls back to initials rather than a broken image. */}
      <IdentityMark
        kind="person"
        size="lg"
        name={name}
        imageUrl={detail.photoUrl}
        metadata={role}
        metadataVisible
      />

      <p className="capiro-directory-rail__office">{officeLine}</p>
      <span className="capiro-directory-rail__divider" aria-hidden="true" />

      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Email</p>
        <p className="capiro-directory-field__value">{email || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Phone</p>
        <p className="capiro-directory-field__value">{phone || 'Not provided'}</p>
      </div>
      <div className="capiro-directory-field">
        <p className="capiro-directory-field__label">Coverage</p>
        <p className="capiro-directory-field__value">{coverage}</p>
      </div>
      {isMember ? (
        <div className="capiro-directory-field">
          <p className="capiro-directory-field__label">Staff</p>
          <p className="capiro-directory-field__value">
            {selection.member.staff.length
              ? `${selection.member.staff.length} on the roster`
              : 'None synced'}
          </p>
        </div>
      ) : null}
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
        <CapiroButton
          variant="primary"
          size="compact"
          onClick={() => (isMember ? onOpenMemberProfile() : onOpenProfile(selection))}
        >
          Open full profile
        </CapiroButton>
        <CapiroButton size="compact" onClick={() => void copyEmail()} disabled={!email}>
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
