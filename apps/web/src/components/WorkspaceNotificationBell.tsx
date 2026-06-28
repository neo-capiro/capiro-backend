// Global top-nav bell for Workspace in-app notifications (E-19).
//
// Lists the current user's recent notifications. A collaborator INVITE that is
// still actionable shows Accept / Decline inline — accept grants access in the
// invited role and notifies the inviter; decline removes the invite. Other
// notifications (accepted/declined notices to the inviter) are informational.
// Reuses the same /workspace-api endpoints the rest of the editor uses.

import { useEffect, useState } from 'react';
import { App as AntApp, Badge, Button, Dropdown, Empty, List, Tag, Typography } from 'antd';
import { BellOutlined } from '@ant-design/icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  useNotifications,
  useMarkNotificationRead,
  useMarkAllNotificationsRead,
  useRespondToInvite,
} from '../pages/workspace/api.js';
import type { WsNotification } from '../pages/workspace/types.js';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function WorkspaceNotificationBell() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = AntApp.useApp();
  const [open, setOpen] = useState(false);

  // Deep-link from the collaborator-invite email (/?notifications=1) opens the
  // dropdown so the invitee can Accept/Decline; strip the param afterward.
  useEffect(() => {
    if (searchParams.get('notifications') === '1') {
      setOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('notifications');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const { data } = useNotifications();
  const markAll = useMarkAllNotificationsRead();
  const markRead = useMarkNotificationRead();
  const respond = useRespondToInvite();

  const items: WsNotification[] = data?.items ?? [];
  const unread = data?.unread ?? 0;

  const onRespond = (draftId: string, collaboratorId: string, action: 'accept' | 'decline') => {
    respond.mutate(
      { draftId, collaboratorId, action },
      {
        onSuccess: () => {
          if (action === 'accept') {
            message.success('Invitation accepted');
            setOpen(false);
            navigate(`/workspace/draft/${draftId}`);
          } else {
            message.info('Invitation declined');
          }
        },
        onError: () => message.error('Could not update the invitation'),
      },
    );
  };

  const panel = (
    <div
      style={{
        width: 360,
        maxHeight: 460,
        overflow: 'auto',
        background: 'var(--bg-surface, #fff)',
        borderRadius: 10,
        boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
        border: '1px solid var(--border-1, #e5e7eb)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '11px 14px',
          borderBottom: '1px solid var(--border-1, #e5e7eb)',
        }}
      >
        <Typography.Text strong>Notifications</Typography.Text>
        {unread > 0 && (
          <Button type="link" size="small" onClick={() => markAll.mutate()}>
            Mark all read
          </Button>
        )}
      </div>
      {items.length === 0 ? (
        <div style={{ padding: 24 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No notifications" />
        </div>
      ) : (
        <List
          dataSource={items}
          renderItem={(n) => {
            const isInvite =
              n.kind === 'collab_invite' && n.actionable && n.draftId && n.collaboratorId;
            return (
              <List.Item
                style={{
                  padding: '10px 14px',
                  background: n.read ? 'transparent' : 'var(--accent-soft, #eef2ff)',
                  display: 'block',
                }}
                onClick={() => {
                  if (!n.read) markRead.mutate(n.id);
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <Typography.Text style={{ fontSize: 13, flex: 1 }}>{n.message}</Typography.Text>
                  {n.kind === 'collab_accepted' && <Tag color="green">accepted</Tag>}
                  {n.kind === 'collab_declined' && <Tag>declined</Tag>}
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--ink-3, #6b7280)' }}>
                  {relativeTime(n.createdAt)}
                </div>
                {isInvite && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <Button
                      type="primary"
                      size="small"
                      loading={respond.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRespond(n.draftId!, n.collaboratorId!, 'accept');
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      size="small"
                      loading={respond.isPending}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRespond(n.draftId!, n.collaboratorId!, 'decline');
                      }}
                    >
                      Decline
                    </Button>
                  </div>
                )}
              </List.Item>
            );
          }}
        />
      )}
    </div>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={setOpen}
      trigger={['click']}
      placement="bottomRight"
      dropdownRender={() => panel}
    >
      <button className="app-topbar-icon-button" type="button" aria-label="Notifications">
        <Badge count={unread} size="small" offset={[-2, 2]}>
          <BellOutlined />
        </Badge>
      </button>
    </Dropdown>
  );
}
