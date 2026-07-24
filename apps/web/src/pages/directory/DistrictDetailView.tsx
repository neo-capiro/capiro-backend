import { Link } from 'react-router-dom';
import { Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import type { AxiosInstance } from 'axios';
import type { DirectoryDistrictDetail } from './directory-api.js';
import { DirectoryProfilePhoto } from './DirectoryProfilePhoto.js';
import { DistrictBoundaryPreview } from './DistrictBoundaryPreview.js';
import { orNotProvided } from './MemberProfileView.js';

const { Title, Text } = Typography;

/** WY's at-large convention; mirrors the API's own '00' path-segment code. */
function districtLabel(district: DirectoryDistrictDetail): string {
  return district.districtNo === '00'
    ? `${district.state} At-Large`
    : `${district.state}-${district.districtNo}`;
}

/**
 * Prop-driven district profile — deep-linkable via
 * /directory/districts/:state/:districtNo. `status` 'C' (current) and 'F'
 * (enacted-but-not-yet-effective) are two distinct resources; the page-level
 * wrapper owns which one is fetched and passes it here already resolved.
 */
export function DistrictDetailView({
  district,
  api,
}: {
  district: DirectoryDistrictDetail;
  api: AxiosInstance;
}) {
  return (
    <div className="directory-profile" data-testid="district-detail">
      <Space align="start" size={20} style={{ marginBottom: 20 }} wrap>
        <div>
          <Title level={3} style={{ marginBottom: 4 }}>
            {districtLabel(district)}
          </Title>
          <div>
            <Text type="secondary">{orNotProvided(district.name)}</Text>
          </div>
          <Space wrap size={[6, 6]} style={{ marginTop: 4 }}>
            <Tag color={district.status === 'C' ? 'green' : 'gold'}>
              {district.status === 'C' ? 'Current map' : 'Enacted (future) map'}
            </Tag>
            <Text type="secondary">Synced {orNotProvided(district.syncedAt)}</Text>
          </Space>
        </div>
      </Space>

      <Card size="small" title="Redistricting" style={{ marginBottom: 16 }}>
        <Descriptions column={2} size="small">
          <Descriptions.Item label="Enacted date">
            {orNotProvided(district.enactedDate)}
          </Descriptions.Item>
          <Descriptions.Item label="Effective date">
            {orNotProvided(district.effectiveDate)}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        size="small"
        title={`Current representative${district.currentMembers.length === 1 ? '' : 's'} (${district.currentMembers.length})`}
        style={{ marginBottom: 16 }}
      >
        {district.currentMembers.length === 0 ? (
          <Empty description="No current representative on record" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          district.currentMembers.map((m) => (
            <Space key={m.id} align="start" size={12} style={{ marginBottom: 8 }}>
              <DirectoryProfilePhoto url={m.photoUrl} name={m.fullName} size={48} />
              <div>
                <Link to={`/directory/members/${encodeURIComponent(m.id)}`}>{m.fullName}</Link>{' '}
                {m.partyName ? <Tag>{m.partyName}</Tag> : null}
                <Tag color="blue">{m.chamber}</Tag>
                {m.outgoingStatus ? <div><Text type="secondary">{m.outgoingStatus}</Text></div> : null}
              </div>
            </Space>
          ))
        )}
      </Card>

      <Card size="small" title="Boundary">
        <DistrictBoundaryPreview
          api={api}
          state={district.state}
          districtNo={district.districtNo}
          status={district.status}
          hasBoundary={district.hasBoundary}
        />
      </Card>
    </div>
  );
}
