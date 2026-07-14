import { Link } from 'react-router-dom';
import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import type { MemberDetail } from './directory-api.js';

const { Title, Text } = Typography;

export const NOT_PROVIDED = 'Not provided by source';

export function orNotProvided(value: string | null | undefined): string {
  return value && String(value).trim() ? String(value) : NOT_PROVIDED;
}

/** Prop-driven member profile — deep-linkable, renders every observed source field. */
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
            {member.bioDetails.partyName ? <Tag color="blue">{member.bioDetails.partyName}</Tag> : null}
            <Text type="secondary">Bioguide {orNotProvided(member.identity.bioguideId)}</Text>
            {member.photoSource ? <Tag>{member.photoSource === 'legistorm' ? 'Source photo' : 'Overlay photo'}</Tag> : null}
          </Space>
          <div>
            <Text type="secondary">Source updated {orNotProvided(member.source.lastUpdatedAt)}</Text>
          </div>
        </div>
      </Space>

      <Card size="small" title="Biography" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Date of birth">{orNotProvided(member.bioDetails.dob)}</Descriptions.Item>
          <Descriptions.Item label="Hometown">{orNotProvided(member.bioDetails.hometown)}</Descriptions.Item>
          <Descriptions.Item label="Place of birth">{orNotProvided(member.bioDetails.placeOfBirth)}</Descriptions.Item>
          <Descriptions.Item label="Occupation">{orNotProvided(member.bioDetails.occupation)}</Descriptions.Item>
          <Descriptions.Item label="Pronunciation">{orNotProvided(member.bioDetails.pronunciation)}</Descriptions.Item>
          <Descriptions.Item label="Gender">{orNotProvided(member.identity.gender)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={`Offices (${member.offices.length})`} style={{ marginBottom: 16 }}>
        {member.offices.length === 0 ? (
          <Empty description={NOT_PROVIDED} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          member.offices.map((office, i) => (
            <div key={i}>
              <Text strong>{orNotProvided(office.name)}</Text>{' '}
              <Text type="secondary">
                {[office.state, office.district ? `District ${office.district}` : null, office.status]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </div>
          ))
        )}
      </Card>

      <Card size="small" title={`Committees & subcommittees (${member.committees.length})`} style={{ marginBottom: 16 }}>
        {member.committees.length === 0 ? (
          <Empty description={NOT_PROVIDED} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          member.committees.map((m, i) => (
            <div key={`${m.committeeId}-${i}`}>
              <Link to={`/directory/committees/${encodeURIComponent(m.committeeId)}`}>{m.committeeId}</Link>{' '}
              <Tag>{m.position ?? 'Member'}</Tag>
            </div>
          ))
        )}
      </Card>

      <Card size="small" title="Leadership" style={{ marginBottom: 16 }}>
        {member.leaderships.length === 0 ? (
          <Empty description={NOT_PROVIDED} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          member.leaderships.map((l, i) => <div key={i}>{orNotProvided(l.position)}</div>)
        )}
      </Card>

      <Card size="small" title={`Photos (${member.photos.length})`} style={{ marginBottom: 16 }}>
        {member.photos.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          <Space wrap>
            {member.photos.map((p) => (
              <span key={p.id ?? p.url}>
                <DirectoryProfilePhoto url={p.url} name={displayName} size={64} />
                {p.url === member.selectedPhotoUrl ? <Tag color="green">Selected</Tag> : null}
              </span>
            ))}
          </Space>
        )}
      </Card>

      <Card size="small" title="Official & social links">
        {member.socialContacts.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          member.socialContacts.map((c, i) => (
            <div key={i}>
              <Text type="secondary">{orNotProvided(c.type)}: </Text>
              <a href={c.value} target="_blank" rel="noreferrer">
                {c.value}
              </a>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
