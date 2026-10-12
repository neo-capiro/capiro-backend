import { useState } from 'react';
import { Alert, Card, Segmented, Space, Typography } from 'antd';
import { useMe } from '../../lib/me.js';
import { MemoryFileEditor } from '../../components/MemoryFileEditor.js';
import { MemoryGovernanceCenterHost } from '../../components/MemoryGovernanceCenterHost.js';

const { Text, Title } = Typography;

/** Settings → Memory: review work first, then active/personal memory files. */
export function MemorySettingsPage() {
  const me = useMe();
  const isAdmin =
    me.data?.role === 'user_admin' || me.data?.role === 'capiro_admin';

  const [scope, setScope] = useState<'firm' | 'user'>('firm');
  const slug = scope === 'firm' ? 'firm' : 'me';
  const canEdit = scope === 'user' || isAdmin;

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <MemoryGovernanceCenterHost isAdmin={isAdmin} />

      <Card>
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <div>
            <Title level={4} style={{ marginBottom: 4 }}>
              Memory Files
            </Title>
            <Text type="secondary">
              Firm knowledge and your personal profile ground Meri and the
              knowledge graph. Shared edits enter the Review Inbox before they
              become active. Per-client memory lives on each client&rsquo;s profile.
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
