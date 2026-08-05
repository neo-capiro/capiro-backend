import { useState } from 'react';
import { Alert, Card, Segmented, Space, Typography } from 'antd';
import { useMe } from '../../lib/me.js';
import { MemoryFileEditor } from '../../components/MemoryFileEditor.js';
import { MemoryGovernanceCenterHost } from '../../components/MemoryGovernanceCenterHost.js';
import { MemoryReviewStatusSummary } from '../../components/MemoryReviewStatusSummary.js';

const { Text, Title } = Typography;

/**
 * Settings → Memory.
 *
 * The Governance Center host preserves standard-user queues and the pre-Phase-15
 * administrator experience until the server explicitly arms the new center.
 */
export function MemorySettingsPage() {
  const me = useMe();
  const isAdmin = me.data?.role === 'user_admin' || me.data?.role === 'capiro_admin';

  const [scope, setScope] = useState<'firm' | 'user'>('firm');
  const slug = scope === 'firm' ? 'firm' : 'me';
  const canEdit = scope === 'user' || isAdmin;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <MemoryReviewStatusSummary />
      <MemoryGovernanceCenterHost isAdmin={isAdmin} />

      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              Memory Files
            </Title>
            <Text type="secondary">
              Firm knowledge and your personal profile that ground Meri and the knowledge graph.
              Write in your own voice; the greyed hints show what belongs in each section.
              Per-client memory now lives on each client&rsquo;s profile (Overview tab).
            </Text>
          </div>

          <Space wrap>
            <Segmented
              value={scope}
              onChange={(value) => setScope(value as 'firm' | 'user')}
              options={[
                { label: 'Firm', value: 'firm' },
                { label: 'My files', value: 'user' },
              ]}
            />
          </Space>

          {!canEdit && (
            <Alert
              type="info"
              showIcon
              message="You can view firm files. Editing firm memory requires an admin role."
            />
          )}
          {scope === 'user' && (
            <Alert
              type="info"
              showIcon
              message={
                'These files are private to you and help Meri work in your voice. ' +
                'Paste real samples under My Writing Style for the best results.'
              }
            />
          )}

          <MemoryFileEditor scope={scope} slug={slug} ready canEdit={canEdit} />
        </Space>
      </Card>
    </Space>
  );
}
