import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getCommitteeContacts } from '../../../pages/directory/directory-api.js';
import type { DirectoryCommitteeMembership } from '../../../pages/directory/directory-api.js';
import { CapiroButton } from '../../components/actions/index.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { IdentityMark } from '../../components/identity/index.js';
import {
  ProfileCard,
  ProfileErrorState,
  ProfileLoading,
  ProfilePage,
} from './profile-primitives.js';

/**
 * Committee dictionary page — Directory vNext (`/directory/committees/:committeeId`).
 *
 * Re-skin of the canonical `CommitteeDirectoryPage` + `CommitteeContactList`:
 * the same `/api/directory/committees/:id/contacts` endpoint under the same
 * `['directory-committee-contacts', id, personType, current, q]` query key,
 * with the personType/current/q filters persisted in the URL so a filtered
 * committee view stays shareable, and every roster row linking to its
 * canonical member/staff profile route.
 */

type PersonTypeFilter = 'all' | 'member' | 'staff';

/** Accessible segmented toggle (kit-pattern; mirrors antd Segmented semantics). */
function SegmentedControl({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly { label: string; value: string }[];
  label: string;
}) {
  return (
    <div className="capiro-dirpage-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          data-selected={value === option.value || undefined}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Unified committee roster: every member + staff row links to its canonical
 * profile route, with photo/initials, role, party/state, and status.
 */
export function CommitteeContactListVNext({
  contacts,
}: {
  contacts: DirectoryCommitteeMembership[];
}) {
  if (contacts.length === 0) {
    return <CapiroEmptyState title="No matching contacts" />;
  }
  return (
    <div className="capiro-dirpage-roster" data-testid="committee-contact-list">
      {contacts.map((m, i) => {
        const route =
          m.person.personType === 'member'
            ? `/directory/members/${encodeURIComponent(m.person.id)}`
            : `/directory/staff/${encodeURIComponent(m.person.id)}`;
        return (
          <div key={`${m.person.id}-${i}`} className="capiro-dirpage-roster__row">
            <IdentityMark
              kind="person"
              size="md"
              name={m.person.fullName || m.person.id}
              imageUrl={m.person.photoUrl}
              aria-hidden="true"
            />
            <div className="capiro-dirpage-roster__main">
              <Link className="capiro-dirprofile__link capiro-dirpage-roster__name" to={route}>
                {m.person.fullName || m.person.id}
              </Link>
              <div className="capiro-dirpage-roster__meta">
                <span className="capiro-dirprofile__meta">
                  {m.position ?? (m.membershipType === 'member' ? 'Member' : 'Staff')}
                </span>
                {m.person.party ? <CapiroBadge>{m.person.party}</CapiroBadge> : null}
                {m.person.state ? <CapiroBadge>{m.person.state}</CapiroBadge> : null}
                <CapiroBadge tone={m.person.isCurrent ? 'success' : 'neutral'}>
                  {m.person.isCurrent ? 'Current' : 'Former'}
                </CapiroBadge>
                <CapiroBadge>{m.membershipType}</CapiroBadge>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function CommitteeProfileVNext({ committeeId }: { committeeId: string }) {
  const api = useApi();
  const [searchParams, setSearchParams] = useSearchParams();

  // Filters persist in the URL so a filtered committee view is shareable.
  const personType = (searchParams.get('personType') as PersonTypeFilter) || 'all';
  const current = searchParams.get('current') === 'true';
  const q = searchParams.get('q') ?? '';
  // Draft mirrors antd Input.Search's uncontrolled defaultValue: typing does
  // not refilter — committing (Enter / Search / clear) writes the URL param.
  const [draft, setDraft] = useState(q);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearchParams(next);
  };

  const query = useQuery({
    queryKey: ['directory-committee-contacts', committeeId, personType, current, q],
    queryFn: () =>
      getCommitteeContacts(api, committeeId, {
        personType: personType === 'all' ? undefined : personType,
        current: current ? 'true' : undefined,
        q: q || undefined,
        pageSize: 500,
      }),
    enabled: Boolean(committeeId),
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous,
    retry: 1,
  });

  const committee = query.data?.committee ?? null;

  return (
    <ProfilePage>
      <Link className="capiro-dirpage__back" to="/directory">
        ← Back to directory
      </Link>

      {query.isLoading ? (
        <ProfileLoading />
      ) : query.isError ? (
        <ProfileErrorState
          title="Committee unavailable"
          description="This committee could not be found in the current directory snapshot."
        />
      ) : (
        <>
          <header className="capiro-dirpage__hero">
            <IdentityMark
              kind="committee"
              size="lg"
              name={committee?.name ?? committeeId}
              aria-hidden="true"
            />
            <div className="capiro-dirpage__hero-main">
              <h1 className="capiro-dirpage__title">{committee?.name ?? committeeId}</h1>
              <div className="capiro-dirprofile__pills">
                {committee?.chamber ? <CapiroBadge tone="info">{committee.chamber}</CapiroBadge> : null}
                {committee?.kind ? <CapiroBadge>{committee.kind}</CapiroBadge> : null}
                {committee?.committeeCode ? <CapiroBadge>{committee.committeeCode}</CapiroBadge> : null}
              </div>
              {typeof committee?.memberCount === 'number' ||
              typeof committee?.currentStaffCount === 'number' ? (
                <p className="capiro-dirprofile__meta">
                  {[
                    typeof committee?.memberCount === 'number' ? `${committee.memberCount} members` : null,
                    typeof committee?.currentStaffCount === 'number'
                      ? `${committee.currentStaffCount} current staff`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              {committee?.officeLocation?.trim() || committee?.phone?.trim() ? (
                <p className="capiro-dirprofile__meta">
                  {[
                    committee?.officeLocation?.trim(),
                    committee?.phone?.trim() ? `Phone: ${committee.phone.trim()}` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              ) : null}
              {committee?.parentCommittee ? (
                <p className="capiro-dirprofile__line">
                  Parent committee:{' '}
                  <Link
                    className="capiro-dirprofile__link"
                    to={`/directory/committees/${encodeURIComponent(committee.parentCommittee.id)}`}
                  >
                    {committee.parentCommittee.name}
                  </Link>
                </p>
              ) : null}
            </div>
          </header>

          {committee?.subcommittees && committee.subcommittees.length > 0 ? (
            <ProfileCard title="Subcommittees">
              <div className="capiro-dirpage__rows">
                {committee.subcommittees.map((s) => (
                  <div key={s.id} className="capiro-dirprofile__line">
                    <Link
                      className="capiro-dirprofile__link"
                      to={`/directory/committees/${encodeURIComponent(s.id)}`}
                    >
                      {s.name}
                    </Link>
                  </div>
                ))}
              </div>
            </ProfileCard>
          ) : null}

          <div className="capiro-dirpage__toolbar">
            <SegmentedControl
              label="Contact type"
              value={personType}
              onChange={(value) => setParam('personType', value === 'all' ? null : value)}
              options={[
                { label: 'Contacts', value: 'all' },
                { label: 'Members', value: 'member' },
                { label: 'Staff', value: 'staff' },
              ]}
            />
            <SegmentedControl
              label="Tenure"
              value={current ? 'current' : 'any'}
              onChange={(value) => setParam('current', value === 'current' ? 'true' : null)}
              options={[
                { label: 'All', value: 'any' },
                { label: 'Current only', value: 'current' },
              ]}
            />
            <div className="capiro-dirpage__search">
              <input
                type="search"
                className="capiro-dirpage__search-input"
                placeholder="Filter by name or role"
                aria-label="Filter by name or role"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setParam('q', draft.trim() || null);
                }}
              />
              <CapiroButton size="compact" onClick={() => setParam('q', draft.trim() || null)}>
                Search
              </CapiroButton>
              {draft || q ? (
                <CapiroButton
                  size="compact"
                  variant="quiet"
                  aria-label="Clear search"
                  onClick={() => {
                    setDraft('');
                    setParam('q', null);
                  }}
                >
                  Clear
                </CapiroButton>
              ) : null}
            </div>
          </div>

          <CommitteeContactListVNext contacts={query.data?.contacts ?? []} />
        </>
      )}
    </ProfilePage>
  );
}
