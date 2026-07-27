/**
 * ReviewQueuePage (route /reviews) — the §3.3 reviewer queue over the G4 reviews
 * backend. Lists held deliverables (enforce-mode auditor holds), each with its
 * hold reason, risk tier, and surface; a reviewer approves (releases it) or
 * rejects. Visible to every real user (standard_user+): the server scopes the
 * list to reviews they requested or are assigned to, while a user_admin sees the
 * whole tenant queue and gets the Assign control. Honest empty state; every
 * collection read is Array.isArray-guarded.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
  // MP-13 / Gate H phase b: revives the already-shipped-but-dead
  // /reviews?id= link (StepGenerate.tsx). The target's status is unknown from
  // the link alone, so default to the 'all' filter rather than 'pending' —
  // otherwise a link to an already-decided review would land on an empty list.
  const targetId = useMemo(() => new URLSearchParams(window.location.search).get('id'), []);
  const [status, setStatus] = useState<StatusFilter>(() => (targetId ? 'all' : 'pending'));

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

  const highlightRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (targetId && highlightRef.current) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [targetId, reviews]);

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
          {reviews.map((review) => {
            const highlighted = !!targetId && review.id === targetId;
            return (
              <div
                key={review.id}
                ref={highlighted ? highlightRef : undefined}
                style={
                  highlighted
                    ? { outline: '2px solid var(--accent, #4f7cff)', outlineOffset: 2, borderRadius: 8 }
                    : undefined
                }
              >
                <ReviewCard review={review} isAdmin={isAdmin} teamMembers={members} />
              </div>
            );
          })}
        </Space>
      )}
    </div>
  );
}
