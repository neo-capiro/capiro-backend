/**
 * ReviewQueuePage (route /reviews) — the §3.3 reviewer queue over the G4 reviews
 * backend. Lists held deliverables (enforce-mode auditor holds), each with its
 * hold reason, risk tier, and surface; a reviewer approves (releases it) or
 * rejects. Visible to every real user (standard_user+): the server scopes the
 * list to reviews they requested or are assigned to, while a user_admin sees the
 * whole tenant queue and gets the Assign control. Honest empty state; every
 * collection read is Array.isArray-guarded.
 */
import { useMemo, useState } from 'react';
import { Button, Empty, Radio, Skeleton, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { isTenantAdmin } from '@capiro/shared';
import { useMe } from '../../lib/me.js';
import { ReviewCard } from './ReviewCard.js';
import { useReviewsList, useTeamMembers } from './reviews-api.js';
import type { ReviewStatus } from './types.js';

const { Title, Text } = Typography;

type StatusFilter = ReviewStatus | 'all';

export function ReviewQueuePage() {
  const me = useMe();
  const [status, setStatus] = useState<StatusFilter>('pending');

  const role = me.data?.role;
  const isAdmin = role ? isTenantAdmin(role) : false;
  const list = useReviewsList(status);
  // Only admins can assign, so only they need the roster.
  const team = useTeamMembers();

  const reviews = useMemo(
    () => (Array.isArray(list.data) ? list.data : []),
    [list.data],
  );
  const members = useMemo(
    () => (isAdmin && Array.isArray(team.data) ? team.data : []),
    [isAdmin, team.data],
  );

  const isLoading = list.isLoading;
  const isEmpty = !isLoading && reviews.length === 0;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto', padding: '0 16px 48px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0' }}>
        <Title level={4} style={{ margin: 0 }}>
          Review Queue
        </Title>
        <Text type="secondary">{reviews.length ? `${reviews.length}` : ''}</Text>
        <span style={{ flex: 1 }} />
        <Button
          icon={<ReloadOutlined />}
          onClick={() => list.refetch()}
          loading={list.isFetching && !list.isLoading}
        >
          Refresh
        </Button>
      </div>

      <div style={{ marginBottom: 16 }}>
        <Radio.Group
          size="small"
          value={status}
          onChange={(e) => setStatus(e.target.value as StatusFilter)}
          optionType="button"
        >
          <Radio.Button value="pending">Pending</Radio.Button>
          <Radio.Button value="approved">Approved</Radio.Button>
          <Radio.Button value="rejected">Rejected</Radio.Button>
          <Radio.Button value="all">All</Radio.Button>
        </Radio.Group>
      </div>

      {isLoading ? (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Skeleton active paragraph={{ rows: 2 }} />
          <Skeleton active paragraph={{ rows: 2 }} />
        </Space>
      ) : isEmpty ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Space direction="vertical" align="center">
              <Text strong>Nothing to review</Text>
              <Text type="secondary">
                Held deliverables (grounding-flagged in enforce mode) show up here for approval.
              </Text>
            </Space>
          }
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {reviews.map((review) => (
            <ReviewCard key={review.id} review={review} isAdmin={isAdmin} teamMembers={members} />
          ))}
        </Space>
      )}
    </div>
  );
}
