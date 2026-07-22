import { Link } from 'react-router-dom';
import { Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import {
  DescriptionsCard,
  ListCard,
  hasText,
  renderOfficeAddress,
} from './directory-profile-helpers.js';
import type { MemberDetail } from './directory-api.js';

const { Title, Text } = Typography;

/** Kept for back-compat with views that still show an explicit placeholder. */
export const NOT_PROVIDED = 'Not provided by source';

export function orNotProvided(value: string | null | undefined): string {
  return value && String(value).trim() ? String(value) : NOT_PROVIDED;
}

/**
 * Prop-driven member profile — deep-linkable. Renders every observed source field but
 * hides any field or section with no value (no "Not provided by source" clutter).
 */
export function MemberProfileView({ member }: { member: MemberDetail }) {
  const displayName = [member.identity.preferredFirstName ?? member.identity.firstName, member.identity.lastName]
    .filter(Boolean)
    .join(' ')
    .trim();

  return (
    <div className="directory-profile" data-testid="member-profile">
      <Space align="start" size={20} style={{ marginBottom: 20 }}>
        <DirectoryProfilePhoto url={member.selectedPhotoUrl} name={displayName} size={104} />
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>
            {displayName}
          </Title>
          <Space wrap size={[6, 6]}>
            {hasText(member.bioDetails.partyName) ? <Tag color="blue">{member.bioDetails.partyName}</Tag> : null}
            {hasText(member.identity.bioguideId) ? (
              <Text type="secondary">Bioguide {member.identity.bioguideId}</Text>
            ) : null}
            {member.photoSource ? (
              <Tag>{member.photoSource === 'legistorm' ? 'Source photo' : 'Overlay photo'}</Tag>
            ) : null}
          </Space>
          {hasText(member.source.lastUpdatedAt) ? (
            <div>
              <Text type="secondary">Source updated {member.source.lastUpdatedAt}</Text>
            </div>
          ) : null}
        </div>
      </Space>

      <DescriptionsCard
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

      <ListCard
        title="Offices"
        items={member.offices}
        render={(office, i) => (
          <div key={i}>
            <Text strong>{hasText(office.name) ? office.name : 'Office'}</Text>{' '}
            <Text type="secondary">
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
            </Text>
          </div>
        )}
      />

      <ListCard
        title="Office addresses"
        items={member.officeAddresses}
        render={renderOfficeAddress}
      />

      <ListCard
        title="Committees & subcommittees"
        items={member.committees}
        render={(m, i) => (
          <div key={`${m.committeeId}-${i}`}>
            <Link to={`/directory/committees/${encodeURIComponent(m.committeeId)}`}>{m.committeeId}</Link>{' '}
            <Tag>{m.position ?? 'Member'}</Tag>
          </div>
        )}
      />

      <ListCard
        title="Leadership"
        showCount={false}
        items={member.leaderships.filter((l) => hasText(l.position))}
        render={(l, i) => <div key={i}>{l.position}</div>}
      />

      <ListCard
        title="Photos"
        items={member.photos}
        render={(p) => (
          <span key={p.id ?? p.url} style={{ marginRight: 8 }}>
            <DirectoryProfilePhoto url={p.url} name={displayName} size={64} />
            {p.url === member.selectedPhotoUrl ? <Tag color="green">Selected</Tag> : null}
          </span>
        )}
      />

      <ListCard
        title="Official & social links"
        showCount={false}
        items={member.socialContacts}
        render={(c, i) => (
          <div key={i}>
            {hasText(c.type) ? <Text type="secondary">{c.type}: </Text> : null}
            <a href={c.value} target="_blank" rel="noreferrer">
              {c.value}
            </a>
          </div>
        )}
      />
    </div>
  );
}
