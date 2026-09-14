import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getStaffDetail } from '../../../pages/directory/directory-api.js';
import type { StaffDetail } from '../../../pages/directory/directory-api.js';
import {
  hasText,
  memberContext,
  normalizeStaffDetail,
} from '../../../pages/directory/directory-profile-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import {
  ContactTripsSectionVNext,
  OfficeAddressBlock,
  ProfileBackLink,
  ProfileDescriptions,
  ProfileErrorState,
  ProfileHero,
  ProfileList,
  ProfileLoading,
  ProfilePage,
} from './profile-primitives.js';

/**
 * Staff profile page — Directory vNext (`/directory/staff/:staffId`).
 *
 * Re-skin of the canonical `StaffDirectoryProfilePage` + `StaffProfileView`
 * pair: same `/api/directory/staffers/:id` resource, same
 * `['directory-staff-detail', id]` query key, same hide-empty rules, same
 * defensive shape normalization (shared via `normalizeStaffDetail`). A staffer
 * is never given a member's photo; committee staff carry no LegiStorm issue
 * data, so the Issue-areas section simply disappears for them.
 */

export function StaffProfileViewVNext({ staff: rawStaff }: { staff: StaffDetail }) {
  const staff = normalizeStaffDetail(rawStaff);
  const displayName = [staff.identity.preferredFirstName ?? staff.identity.firstName, staff.identity.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const currentTitle =
    staff.positions.find((p) => p.isCurrent)?.title ?? staff.positions[0]?.title ?? null;

  return (
    <article className="capiro-dirpage__profile" data-testid="staff-profile">
      <ProfileHero name={displayName} photoUrl={staff.photoUrl}>
        {hasText(currentTitle) ? <p className="capiro-dirprofile__role">{currentTitle}</p> : null}
        <div className="capiro-dirprofile__pills">
          {staff.availability.photo === 'available' ? (
            <CapiroBadge tone="success">Photo available</CapiroBadge>
          ) : null}
          {staff.availability.socialContacts === 'available' ? (
            <CapiroBadge tone="success">Social available</CapiroBadge>
          ) : null}
        </div>
        {hasText(staff.source.lastUpdatedAt) ? (
          <p className="capiro-dirprofile__meta">Source updated {staff.source.lastUpdatedAt}</p>
        ) : null}
      </ProfileHero>

      <ProfileDescriptions
        title="Identity & bio"
        fields={[
          { label: 'Staff ID', value: String(staff.identity.staffId) },
          { label: 'Gender', value: staff.identity.gender },
          { label: 'Suffix', value: staff.identity.suffix },
          { label: 'Party', value: staff.bioDetails.partyName },
          { label: 'Majority/Minority', value: staff.bioDetails.majMin },
          { label: 'Occupation', value: staff.bioDetails.occupation },
          { label: 'Date of birth', value: staff.bioDetails.dob },
          { label: 'Date of death', value: staff.bioDetails.dateOfDeath },
          { label: 'Hometown', value: staff.bioDetails.hometown },
          { label: 'Place of birth', value: staff.bioDetails.placeOfBirth },
          { label: 'Native of', value: staff.bioDetails.nativeOf },
          { label: 'Pronunciation', value: staff.bioDetails.pronunciation },
          { label: 'Race', value: staff.bioDetails.raceName },
          { label: 'Religion', value: staff.bioDetails.religionName },
        ]}
      />

      <ProfileList
        title="Roles"
        items={staff.roles}
        render={(r, i) => (
          <div key={`${r.roleName}-${r.memberId}-${i}`} className="capiro-dirpage__row">
            <span className="capiro-dirpage__row-title">
              {hasText(r.roleName) ? r.roleName : 'Role'}
            </span>{' '}
            {r.memberId != null ? (
              <Link className="capiro-dirprofile__link" to={`/directory/members/member-${r.memberId}`}>
                {r.memberName || `member-${r.memberId}`}
              </Link>
            ) : null}
          </div>
        )}
      />

      <ProfileList
        title="Issue areas"
        items={staff.issues}
        render={(iss, i) => (
          <div key={`${iss.issueName}-${iss.memberId}-${i}`} className="capiro-dirpage__row">
            {hasText(iss.issueName) ? <CapiroBadge>{iss.issueName}</CapiroBadge> : null}{' '}
            {iss.memberId != null ? (
              <Link className="capiro-dirprofile__link" to={`/directory/members/member-${iss.memberId}`}>
                {iss.memberName || `member-${iss.memberId}`}
              </Link>
            ) : null}
          </div>
        )}
      />

      <ProfileList
        title="Emails"
        items={staff.emails}
        render={(e, i) => (
          <div key={i} className="capiro-dirprofile__line">
            <a className="capiro-dirprofile__link" href={`mailto:${e.value}`}>
              {e.value}
            </a>
            {hasText(e.type) ? <span className="capiro-dirprofile__meta"> ({e.type})</span> : null}
          </div>
        )}
      />

      <ProfileList
        title="Offices"
        items={staff.officeAddresses}
        render={(a, i) => <OfficeAddressBlock key={a.addressId ?? i} address={a} />}
      />

      <ProfileList
        title="Positions"
        items={staff.positions}
        render={(p, i) => (
          <div key={i} className="capiro-dirpage__row">
            <span className="capiro-dirpage__row-title">
              {hasText(p.title) ? p.title : 'Position'}
            </span>{' '}
            <span className="capiro-dirprofile__meta">
              {hasText(p.officeName) ? p.officeName : ''}
              {p.member?.fullName ? ` · ${p.member.fullName} ${memberContext(p.member)}`.trimEnd() : ''}
            </span>{' '}
            {p.isCurrent ? <CapiroBadge tone="success">Current</CapiroBadge> : <CapiroBadge>Former</CapiroBadge>}
            {p.isOnLeave ? <CapiroBadge tone="warning">On leave</CapiroBadge> : null}
            {hasText(p.positionType) ? (
              <span className="capiro-dirprofile__meta"> · {p.positionType}</span>
            ) : null}
            {p.startDate || p.endDate ? (
              <span className="capiro-dirprofile__meta">
                {' '}
                ({p.startDate ?? 'unknown'} – {p.endDate ?? 'present'})
              </span>
            ) : null}
          </div>
        )}
      />

      <ProfileList
        title="Member associations"
        showCount={false}
        items={staff.memberAssociations}
        render={(m) => (
          <div key={m.id} className="capiro-dirpage__row">
            <Link className="capiro-dirprofile__link" to={`/directory/members/${encodeURIComponent(m.id)}`}>
              {m.fullName || m.id}
            </Link>{' '}
            <span className="capiro-dirprofile__meta">{memberContext(m)}</span>
          </div>
        )}
      />

      <ProfileList
        title="Committee associations"
        showCount={false}
        items={staff.committeeAssociations}
        render={(c, i) => (
          <div key={`${c.committeeId}-${i}`} className="capiro-dirpage__row">
            <Link
              className="capiro-dirprofile__link"
              to={`/directory/committees/${encodeURIComponent(c.committeeId)}`}
            >
              {c.committeeName?.trim() || 'Committee name unavailable'}
            </Link>{' '}
            <CapiroBadge>{c.position ?? 'Staff'}</CapiroBadge>
          </div>
        )}
      />

      <ContactTripsSectionVNext contactId={staff.id} />
    </article>
  );
}

export function StaffProfileVNext({ staffId }: { staffId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['directory-staff-detail', staffId],
    queryFn: () => getStaffDetail(api, staffId),
    enabled: Boolean(staffId),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <ProfilePage>
      <ProfileBackLink navigate={navigate} />
      {query.isLoading ? (
        <ProfileLoading />
      ) : query.isError || !query.data ? (
        <ProfileErrorState
          title="Staff profile unavailable"
          description="This staffer could not be found in the current directory snapshot."
        />
      ) : (
        <StaffProfileViewVNext staff={query.data} />
      )}
    </ProfilePage>
  );
}
