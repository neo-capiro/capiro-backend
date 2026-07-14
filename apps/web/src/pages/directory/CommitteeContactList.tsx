import { Link } from 'react-router-dom';
import { Empty, Space, Tag, Typography } from 'antd';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import type { DirectoryCommitteeMembership } from './directory-api.js';

const { Text } = Typography;

/**
 * Presentational unified committee roster: every member + staff row links to its
 * canonical profile route, with photo/initials, role, party/state, and status.
 */
export function CommitteeContactList({ contacts }: { contacts: DirectoryCommitteeMembership[] }) {
  if (contacts.length === 0) {
    return <Empty description="No matching contacts" image={Empty.PRESENTED_IMAGE_SIMPLE} />;
  }
  return (
    <div data-testid="committee-contact-list">
      {contacts.map((m, i) => {
        const route =
          m.person.personType === 'member'
            ? `/directory/members/${encodeURIComponent(m.person.id)}`
            : `/directory/staff/${encodeURIComponent(m.person.id)}`;
        return (
          <div
            key={`${m.person.id}-${i}`}
            className="dir-committee-contact-row"
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0' }}
          >
            <DirectoryProfilePhoto url={m.person.photoUrl} name={m.person.fullName} size={40} />
            <div style={{ flex: 1 }}>
              <Link to={route}>{m.person.fullName || m.person.id}</Link>
              <div>
                <Space size={6} wrap>
                  <Text type="secondary">{m.position ?? (m.membershipType === 'member' ? 'Member' : 'Staff')}</Text>
                  {m.person.party ? <Tag>{m.person.party}</Tag> : null}
                  {m.person.state ? <Tag>{m.person.state}</Tag> : null}
                  <Tag color={m.person.isCurrent ? 'green' : 'default'}>
                    {m.person.isCurrent ? 'Current' : 'Former'}
                  </Tag>
                  <Tag>{m.membershipType}</Tag>
                </Space>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
