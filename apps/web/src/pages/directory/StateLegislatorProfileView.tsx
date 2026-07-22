import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { stateBillStatusLabel } from '@capiro/shared';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import { NOT_PROVIDED, orNotProvided } from './MemberProfileView.js';
import type { StateLegislatorDetail } from './StateLegislatorDirectory.js';

const { Title, Text, Link: TextLink } = Typography;

/** upper => Senate, lower => House/Assembly; anything else shown verbatim. */
export function chamberLabel(chamber: string | null | undefined): string | null {
  if (!chamber) return null;
  const c = chamber.toLowerCase();
  if (c === 'upper') return 'Senate (upper)';
  if (c === 'lower') return 'House (lower)';
  return chamber;
}

/**
 * Prop-driven state-legislator profile — the page-level parity of MemberProfileView
 * for OpenStates legislators. Deep-linkable via /directory/state-legislators/:id.
 */
export function StateLegislatorProfileView({ legislator }: { legislator: StateLegislatorDetail }) {
  const districtLine = [
    legislator.state,
    chamberLabel(legislator.chamber),
    legislator.district ? `District ${legislator.district}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const bills = legislator.sponsoredBills;

  return (
    <div className="directory-profile" data-testid="state-legislator-profile">
      <Space align="start" size={20} style={{ marginBottom: 20 }}>
        <DirectoryProfilePhoto url={legislator.image} name={legislator.name} size={104} />
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>
            {legislator.name}
          </Title>
          <div>
            <Text type="secondary">{orNotProvided(districtLine || null)}</Text>
          </div>
          <Space wrap size={[6, 6]} style={{ marginTop: 4 }}>
            {legislator.party ? <Tag>{legislator.party}</Tag> : null}
            <Tag color={legislator.active ? 'green' : 'default'}>
              {legislator.active ? 'Active' : 'Inactive'}
            </Tag>
            <Text type="secondary">Synced {orNotProvided(legislator.syncedAt)}</Text>
          </Space>
        </div>
      </Space>

      <Card size="small" title="Contact" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Email">
            {legislator.email ? (
              <a href={`mailto:${legislator.email}`}>{legislator.email}</a>
            ) : (
              NOT_PROVIDED
            )}
          </Descriptions.Item>
          <Descriptions.Item label="Website">
            {legislator.url ? (
              <TextLink href={legislator.url} target="_blank" rel="noreferrer">
                {legislator.url}
              </TextLink>
            ) : (
              NOT_PROVIDED
            )}
          </Descriptions.Item>
          <Descriptions.Item label="State">{orNotProvided(legislator.state)}</Descriptions.Item>
          <Descriptions.Item label="Chamber">
            {orNotProvided(chamberLabel(legislator.chamber))}
          </Descriptions.Item>
          <Descriptions.Item label="District">{orNotProvided(legislator.district)}</Descriptions.Item>
          <Descriptions.Item label="Party">{orNotProvided(legislator.party)}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card size="small" title={`Committees (${legislator.committees.length})`} style={{ marginBottom: 16 }}>
        {legislator.committees.length === 0 ? (
          <Text type="secondary">{NOT_PROVIDED}</Text>
        ) : (
          legislator.committees.map((c) => (
            <div key={c.id}>
              <Text strong>{orNotProvided(c.name)}</Text>{' '}
              {c.role ? <Tag>{c.role}</Tag> : null}
              {c.chamber ? <Text type="secondary"> · {chamberLabel(c.chamber)}</Text> : null}
            </div>
          ))
        )}
      </Card>

      <Card
        size="small"
        title={`Sponsored bills${bills ? ` (${legislator.sponsoredBillsTotal})` : ''}`}
      >
        {bills === null ? (
          // null (not []) = never crosswalked to LegiScan; do NOT claim "sponsors nothing".
          <Text type="secondary">Bill sponsorship data not available for this legislator</Text>
        ) : bills.length === 0 ? (
          <Empty description="No sponsored bills on record" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          bills.map((b) => (
            <div key={b.billId} style={{ marginBottom: 4 }}>
              <Text strong>{orNotProvided(b.identifier)}</Text>{' '}
              <Text>{orNotProvided(b.title)}</Text>{' '}
              {b.status ? <Tag>{stateBillStatusLabel(b.status)}</Tag> : null}
              {b.sponsorType ? <Text type="secondary"> · {b.sponsorType}</Text> : null}
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
