import { Link } from 'react-router-dom';
import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import { NOT_PROVIDED, orNotProvided } from './MemberProfileView.js';
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
          <Descriptions.Item label="Suffix">{orNotProvided(staff.identity.suffix)}</Descriptions.Item>
          <Descriptions.Item label="Party">{orNotProvided(staff.bioDetails.partyName)}</Descriptions.Item>
          <Descriptions.Item label="Majority/Minority">
            {orNotProvided(staff.bioDetails.majMin)}
          </Descriptions.Item>
          <Descriptions.Item label="Occupation">{orNotProvided(staff.bioDetails.occupation)}</Descriptions.Item>
          <Descriptions.Item label="Date of birth">{orNotProvided(staff.bioDetails.dob)}</Descriptions.Item>
          <Descriptions.Item label="Date of death">
            {orNotProvided(staff.bioDetails.dateOfDeath)}
          </Descriptions.Item>
          <Descriptions.Item label="Hometown">{orNotProvided(staff.bioDetails.hometown)}</Descriptions.Item>
          <Descriptions.Item label="Place of birth">
            {orNotProvided(staff.bioDetails.placeOfBirth)}
          </Descriptions.Item>
          <Descriptions.Item label="Native of">{orNotProvided(staff.bioDetails.nativeOf)}</Descriptions.Item>
          <Descriptions.Item label="Pronunciation">
            {orNotProvided(staff.bioDetails.pronunciation)}
          </Descriptions.Item>
          <Descriptions.Item label="Race">{orNotProvided(staff.bioDetails.raceName)}</Descriptions.Item>
          <Descriptions.Item label="Religion">{orNotProvided(staff.bioDetails.religionName)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={`Roles (${staff.roles.length})`} style={{ marginBottom: 16 }}>
        {staff.roles.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.roles.map((r, i) => (
            <div key={`${r.roleName}-${r.memberId}-${i}`}>
              <Text strong>{orNotProvided(r.roleName)}</Text>{' '}
              {r.memberId != null ? (
                <Link to={`/directory/members/member-${r.memberId}`}>
                  <Text type="secondary">{r.memberName || `member-${r.memberId}`}</Text>
                </Link>
              ) : null}
            </div>
          ))
        )}
      </Card>

      <Card size="small" title={`Issue areas (${staff.issues.length})`} style={{ marginBottom: 16 }}>
        {staff.issues.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.issues.map((iss, i) => (
            <div key={`${iss.issueName}-${iss.memberId}-${i}`}>
              <Tag>{orNotProvided(iss.issueName)}</Tag>{' '}
              {iss.memberId != null ? (
                <Link to={`/directory/members/member-${iss.memberId}`}>
                  <Text type="secondary">{iss.memberName || `member-${iss.memberId}`}</Text>
                </Link>
              ) : null}
            </div>
          ))
        )}
      </Card>

      <Card size="small" title={`Emails (${staff.emails.length})`} style={{ marginBottom: 16 }}>
        {staff.emails.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.emails.map((e, i) => (
            <div key={i}>
              <a href={`mailto:${e.value}`}>{e.value}</a>
              {e.type ? <Text type="secondary"> ({e.type})</Text> : null}
            </div>
          ))
        )}
      </Card>

      <Card size="small" title={`Offices (${staff.officeAddresses.length})`} style={{ marginBottom: 16 }}>
        {staff.officeAddresses.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          staff.officeAddresses.map((a, i) => (
            <div key={a.addressId ?? i} style={{ marginBottom: 8 }}>
              <div>
                <Text strong>{orNotProvided(a.label ?? a.officeName)}</Text>{' '}
                {a.isMain ? <Tag color="blue">Main</Tag> : null}
              </div>
              <div>
                <Text type="secondary">
                  {[a.address1, a.address2, [a.city, a.state, [a.zip, a.zipExt].filter(Boolean).join('-')]
                    .filter(Boolean)
                    .join(', ')]
                    .filter(Boolean)
                    .join(', ') || NOT_PROVIDED}
                </Text>
              </div>
              <div>
                <Text type="secondary">Phone: {orNotProvided(a.phone)}</Text>
                {a.fax ? <Text type="secondary"> · Fax: {a.fax}</Text> : null}
              </div>
              {a.publicNotes ? (
                <div>
                  <Text type="secondary">{a.publicNotes}</Text>
                </div>
              ) : null}
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
              <Text type="secondary">
                {orNotProvided(p.officeName)}
                {p.member?.fullName ? ` · ${p.member.fullName} ${memberContext(p.member)}`.trimEnd() : ''}
              </Text>{' '}
              {p.isCurrent ? <Tag color="green">Current</Tag> : <Tag>Former</Tag>}
              {p.isOnLeave ? <Tag color="orange">On leave</Tag> : null}
              {p.positionType ? <Text type="secondary"> · {p.positionType}</Text> : null}
              {p.startDate || p.endDate ? (
                <Text type="secondary">
                  {' '}
                  ({orNotProvided(p.startDate)} – {p.endDate ?? 'present'})
                </Text>
              ) : null}
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
              <Link to={`/directory/members/${encodeURIComponent(m.id)}`}>{m.fullName || m.id}</Link>{' '}
              <Text type="secondary">{memberContext(m)}</Text>
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
