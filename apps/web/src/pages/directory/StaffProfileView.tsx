import { Link } from 'react-router-dom';
import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import { NOT_PROVIDED, orNotProvided } from './MemberProfileView.js';
import type { StaffDetail } from './directory-api.js';

const { Title, Text } = Typography;

/** Prop-driven staff profile — deep-linkable; never shows a member's photo. */
export function StaffProfileView({ staff }: { staff: StaffDetail }) {
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
          <div>
            <Text>{orNotProvided(currentTitle)}</Text>
          </div>
          <Space wrap size={[6, 6]}>
            <Tag color={staff.availability.photo === 'available' ? 'green' : 'default'}>
              Photo: {staff.availability.photo === 'available' ? 'available' : NOT_PROVIDED}
            </Tag>
            <Tag color={staff.availability.socialContacts === 'available' ? 'green' : 'default'}>
              Social: {staff.availability.socialContacts === 'available' ? 'available' : NOT_PROVIDED}
            </Tag>
            <Text type="secondary">Source updated {orNotProvided(staff.source.lastUpdatedAt)}</Text>
          </Space>
        </div>
      </Space>

      <Card size="small" title="Identity & bio" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Staff ID">{staff.identity.staffId}</Descriptions.Item>
          <Descriptions.Item label="Gender">{orNotProvided(staff.identity.gender)}</Descriptions.Item>
          <Descriptions.Item label="Occupation">{orNotProvided(staff.bioDetails.occupation)}</Descriptions.Item>
          <Descriptions.Item label="Party">{orNotProvided(staff.bioDetails.partyName)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={`Emails (${staff.emails.length})`} style={{ marginBottom: 16 }}>
        {staff.emails.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.emails.map((e, i) => (
            <div key={i}>
              <a href={`mailto:${e.value}`}>{e.value}</a>
            </div>
          ))
        )}
      </Card>

      <Card size="small" title={`Positions (${staff.positions.length})`} style={{ marginBottom: 16 }}>
        {staff.positions.length === 0 ? (
          <Empty description={NOT_PROVIDED} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          staff.positions.map((p, i) => (
            <div key={i}>
              <Text strong>{orNotProvided(p.title)}</Text>{' '}
              <Text type="secondary">{orNotProvided(p.officeName)}</Text>{' '}
              {p.isCurrent ? <Tag color="green">Current</Tag> : <Tag>Former</Tag>}
            </div>
          ))
        )}
      </Card>

      <Card size="small" title="Member associations" style={{ marginBottom: 16 }}>
        {staff.memberAssociations.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.memberAssociations.map((m) => (
            <div key={m.id}>
              <Link to={`/directory/members/${encodeURIComponent(m.id)}`}>{m.fullName || m.id}</Link>
            </div>
          ))
        )}
      </Card>

      <Card size="small" title="Committee associations">
        {staff.committeeAssociations.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.committeeAssociations.map((c, i) => (
            <div key={`${c.committeeId}-${i}`}>
              <Link to={`/directory/committees/${encodeURIComponent(c.committeeId)}`}>{c.committeeId}</Link>{' '}
              <Tag>{c.position ?? 'Staff'}</Tag>
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
