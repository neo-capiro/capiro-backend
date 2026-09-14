import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../../../lib/use-api.js';
import { getMemberDetail } from '../../../pages/directory/directory-api.js';
import type { MemberDetail } from '../../../pages/directory/directory-api.js';
import { hasText } from '../../../pages/directory/directory-profile-shared.js';
import { CapiroBadge } from '../../components/badges/index.js';
import { IdentityMark } from '../../components/identity/index.js';
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
 * Member profile page — Directory vNext (`/directory/members/:memberId`).
 *
 * Re-skin of the canonical `MemberDirectoryProfilePage` + `MemberProfileView`
 * pair: the same `/api/directory/members/:id` resource under the same
 * `['directory-member-detail', id]` query key, the same "render every observed
 * source field but hide any field or section with no value" rule, and the same
 * committee/trips wiring. This is deliberately NOT the MemberProfileModalVNext
 * body: the modal renders the Congressional Staff list's `DirectoryEntry`
 * (list snapshot + notes/FEC/news side endpoints) while this page renders the
 * member-detail resource — reusing the modal would have swapped the page's
 * endpoint, query key and field set, which the re-skin rules forbid.
 */

export function MemberProfileViewVNext({ member }: { member: MemberDetail }) {
  const displayName = [member.identity.preferredFirstName ?? member.identity.firstName, member.identity.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    <article className="capiro-dirpage__profile" data-testid="member-profile">
      <ProfileHero name={displayName} photoUrl={member.selectedPhotoUrl}>
        <div className="capiro-dirprofile__pills">
          {hasText(member.bioDetails.partyName) ? (
            <CapiroBadge tone="info">{member.bioDetails.partyName}</CapiroBadge>
          ) : null}
          {member.photoSource ? (
            <CapiroBadge>{member.photoSource === 'legistorm' ? 'Source photo' : 'Overlay photo'}</CapiroBadge>
          ) : null}
        </div>
        {hasText(member.identity.bioguideId) ? (
          <p className="capiro-dirprofile__meta">Bioguide {member.identity.bioguideId}</p>
        ) : null}
        {hasText(member.source.lastUpdatedAt) ? (
          <p className="capiro-dirprofile__meta">Source updated {member.source.lastUpdatedAt}</p>
        ) : null}
      </ProfileHero>

      <ProfileDescriptions
        title="Biography"
        fields={[
          { label: 'Date of birth', value: member.bioDetails.dob },
          { label: 'Date of death', value: member.bioDetails.dateOfDeath },
          { label: 'Hometown', value: member.bioDetails.hometown },
          { label: 'Native of', value: member.bioDetails.nativeOf },
          { label: 'Place of birth', value: member.bioDetails.placeOfBirth },
          { label: 'Occupation', value: member.bioDetails.occupation },
          { label: 'Pronunciation', value: member.bioDetails.pronunciation },
          { label: 'Majority/Minority', value: member.bioDetails.majMin },
          { label: 'Gender', value: member.identity.gender },
        ]}
      />

      <ProfileList
        title="Offices"
        items={member.offices}
        render={(office, i) => (
          <div key={i} className="capiro-dirpage__row">
            <span className="capiro-dirpage__row-title">
              {hasText(office.name) ? office.name : 'Office'}
            </span>{' '}
            <span className="capiro-dirprofile__meta">
              {[
                office.state,
                office.district ? `District ${office.district}` : null,
                office.party,
                hasText(office.senateClass) ? `Class ${office.senateClass}` : null,
                office.status,
                office.outgoingStatus,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        )}
      />

      <ProfileList
        title="Office addresses"
        items={member.officeAddresses}
        render={(a, i) => <OfficeAddressBlock key={a.addressId ?? i} address={a} />}
      />

      <ProfileList
        title="Committees & subcommittees"
        items={member.committees}
        render={(m, i) => (
          <div key={`${m.committeeId}-${i}`} className="capiro-dirpage__row">
            <Link
              className="capiro-dirprofile__link"
              to={`/directory/committees/${encodeURIComponent(m.committeeId)}`}
            >
              {m.committeeName?.trim() || 'Committee name unavailable'}
            </Link>{' '}
            <CapiroBadge>{m.position ?? 'Member'}</CapiroBadge>
          </div>
        )}
      />

      <ProfileList
        title="Leadership"
        showCount={false}
        items={member.leaderships.filter((l) => hasText(l.position))}
        render={(l, i) => (
          <div key={i} className="capiro-dirprofile__line">
            {l.position}
          </div>
        )}
      />

      <ProfileList
        title="Photos"
        layout="row"
        items={member.photos}
        render={(p) => (
          <span key={p.id ?? p.url} className="capiro-dirpage__photo">
            <IdentityMark kind="person" size="lg" name={displayName} imageUrl={p.url} />
            {p.url === member.selectedPhotoUrl ? (
              <CapiroBadge tone="success">Selected</CapiroBadge>
            ) : null}
          </span>
        )}
      />

      <ProfileList
        title="Official & social links"
        showCount={false}
        items={member.socialContacts}
        render={(c, i) => (
          <div key={i} className="capiro-dirprofile__line">
            {hasText(c.type) ? <span className="capiro-dirprofile__meta">{c.type}: </span> : null}
            <a className="capiro-dirprofile__link" href={c.value} target="_blank" rel="noreferrer">
              {c.value}
            </a>
          </div>
        )}
      />

      <ContactTripsSectionVNext contactId={member.id} />
    </article>
  );
}

export function MemberProfileVNext({ memberId }: { memberId: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['directory-member-detail', memberId],
    queryFn: () => getMemberDetail(api, memberId),
    enabled: Boolean(memberId),
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
          title="Member profile unavailable"
          description="This member could not be found in the current directory snapshot."
        />
      ) : (
        <MemberProfileViewVNext member={query.data} />
      )}
    </ProfilePage>
  );
}
