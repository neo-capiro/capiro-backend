import { Link } from 'react-router-dom';
import { Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import {
  DescriptionsCard,
  ListCard,
  hasText,
  renderOfficeAddress,
} from './directory-profile-helpers.js';
import type { StaffDetail } from './directory-api.js';

const { Title, Text } = Typography;

/** Format a member's party/state/district into a compact "(D-CA-12)" style suffix. */
function memberContext(m: {
  party: string | null;
  state: string | null;
  district: string | null;
}): string {
  const inner = [m.party, m.state, m.district].filter(Boolean).join('-');
  return inner ? `(${inner})` : '';
}

/**
 * Prop-driven staff profile — deep-linkable; never shows a member's photo. Renders every
 * observed source field but hides any field/section with no value. Committee staff have
 * no LegiStorm issue data, so the Issue-areas section simply disappears for them.
 */
export function StaffProfileView({ staff: rawStaff }: { staff: StaffDetail }) {
  // Defensive normalization: never assume the arrays/objects are present, so a
  // shape drift can't blank the whole profile with a client-side crash. The rest
  // of the component reads `staff` and so transparently gets the guarded values.
  const staff: StaffDetail = {
    ...rawStaff,
    bioDetails: rawStaff.bioDetails ?? ({} as StaffDetail['bioDetails']),
    emails: rawStaff.emails ?? [],
    socialContacts: rawStaff.socialContacts ?? [],
    officeAddresses: rawStaff.officeAddresses ?? [],
    positions: rawStaff.positions ?? [],
    memberAssociations: rawStaff.memberAssociations ?? [],
    committeeAssociations: rawStaff.committeeAssociations ?? [],
    issues: rawStaff.issues ?? [],
    roles: rawStaff.roles ?? [],
  };
  const displayName = [staff.identity.preferredFirstName ?? staff.identity.firstName, staff.identity.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();
  const currentTitle = staff.positions.find((p) => p.isCurrent)?.title ?? staff.positions[0]?.title ?? null;

  return (
    <div className="directory-profile" data-testid="staff-profile">
      <Space align="start" size={20} style={{ marginBottom: 20 }}>
        <DirectoryProfilePhoto url={staff.photoUrl} name={displayName} size={104} />
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>
            {displayName}
          </Title>
          {hasText(currentTitle) ? (
            <div>
              <Text>{currentTitle}</Text>
            </div>
          ) : null}
          <Space wrap size={[6, 6]}>
            {staff.availability.photo === 'available' ? <Tag color="green">Photo available</Tag> : null}
            {staff.availability.socialContacts === 'available' ? (
              <Tag color="green">Social available</Tag>
            ) : null}
            {hasText(staff.source.lastUpdatedAt) ? (
              <Text type="secondary">Source updated {staff.source.lastUpdatedAt}</Text>
            ) : null}
          </Space>
        </div>
      </Space>

      <DescriptionsCard
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

      <ListCard
        title="Roles"
        items={staff.roles}
        render={(r, i) => (
          <div key={`${r.roleName}-${r.memberId}-${i}`}>
            <Text strong>{hasText(r.roleName) ? r.roleName : 'Role'}</Text>{' '}
            {r.memberId != null ? (
              <Link to={`/directory/members/member-${r.memberId}`}>
                <Text type="secondary">{r.memberName || `member-${r.memberId}`}</Text>
              </Link>
            ) : null}
          </div>
        )}
      />

      <ListCard
        title="Issue areas"
        items={staff.issues}
        render={(iss, i) => (
          <div key={`${iss.issueName}-${iss.memberId}-${i}`}>
            {hasText(iss.issueName) ? <Tag>{iss.issueName}</Tag> : null}{' '}
            {iss.memberId != null ? (
              <Link to={`/directory/members/member-${iss.memberId}`}>
                <Text type="secondary">{iss.memberName || `member-${iss.memberId}`}</Text>
              </Link>
            ) : null}
          </div>
        )}
      />

      <ListCard
        title="Emails"
        items={staff.emails}
        render={(e, i) => (
          <div key={i}>
            <a href={`mailto:${e.value}`}>{e.value}</a>
            {hasText(e.type) ? <Text type="secondary"> ({e.type})</Text> : null}
          </div>
        )}
      />

      <ListCard title="Offices" items={staff.officeAddresses} render={renderOfficeAddress} />

      <ListCard
        title="Positions"
        items={staff.positions}
        render={(p, i) => (
          <div key={i}>
            <Text strong>{hasText(p.title) ? p.title : 'Position'}</Text>{' '}
            <Text type="secondary">
              {hasText(p.officeName) ? p.officeName : ''}
              {p.member?.fullName ? ` · ${p.member.fullName} ${memberContext(p.member)}`.trimEnd() : ''}
            </Text>{' '}
            {p.isCurrent ? <Tag color="green">Current</Tag> : <Tag>Former</Tag>}
            {p.isOnLeave ? <Tag color="orange">On leave</Tag> : null}
            {hasText(p.positionType) ? <Text type="secondary"> · {p.positionType}</Text> : null}
            {p.startDate || p.endDate ? (
              <Text type="secondary">
                {' '}
                ({p.startDate ?? 'unknown'} – {p.endDate ?? 'present'})
              </Text>
            ) : null}
          </div>
        )}
      />

      <ListCard
        title="Member associations"
        showCount={false}
        items={staff.memberAssociations}
        render={(m) => (
          <div key={m.id}>
            <Link to={`/directory/members/${encodeURIComponent(m.id)}`}>{m.fullName || m.id}</Link>{' '}
            <Text type="secondary">{memberContext(m)}</Text>
          </div>
        )}
      />

      <ListCard
        title="Committee associations"
        showCount={false}
        items={staff.committeeAssociations}
        render={(c, i) => (
          <div key={`${c.committeeId}-${i}`}>
            <Link to={`/directory/committees/${encodeURIComponent(c.committeeId)}`}>{c.committeeId}</Link>{' '}
            <Tag>{c.position ?? 'Staff'}</Tag>
          </div>
        )}
      />
    </div>
  );
}
