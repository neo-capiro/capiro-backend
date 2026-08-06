import { useMemo, useState } from 'react';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Statistic,
  Tabs,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import {
  BellOutlined,
  CheckOutlined,
  CloseOutlined,
  EditOutlined,
  EyeOutlined,
  ReloadOutlined,
  StopOutlined,
  SwapOutlined,
} from '@ant-design/icons';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/use-api.js';

const { Paragraph, Text, Title } = Typography;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MemoryReviewInboxView =
  | 'needs_my_review'
  | 'submitted_by_me'
  | 'all_pending'
  | 'blocked'
  | 'history';

export type MemoryReviewStatus =
  | 'pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected'
  | 'withdrawn'
  | 'superseded';

export interface MemoryReviewInboxItem {
  candidateId: string;
  reviewRequestId: string;
  candidateKind: 'standard' | 'correction' | 'restore' | 'contradiction';
  scope: 'firm' | 'client';
  client: { id: string; name: string; status: string | null } | null;
  title: string;
  status: MemoryReviewStatus;
  revisionNumber: number;
  rootCandidateId: string;
  predecessorCandidateId: string | null;
  submittedBy: { userId: string; name: string };
  assignedReviewer: { userId: string; name: string } | null;
  decidedBy: { userId: string; name: string } | null;
  createdAt: string;
  decidedAt: string | null;
  blockedReason:
    | 'no_reviewer'
    | 'reviewer_unavailable'
    | 'archived_client'
    | null;
  nextAction:
    | 'review'
    | 'revise'
    | 'await_reviewer'
    | 'assign_reviewer'
    | 'none';
  capabilities: {
    open: boolean;
    approve: boolean;
    reject: boolean;
    requestChanges: boolean;
    revise: boolean;
    reassign: boolean;
    withdraw: boolean;
  };
}

interface InboxPage {
  enabled: boolean;
  view: MemoryReviewInboxView;
  items: MemoryReviewInboxItem[];
  nextCursor: string | null;
}

interface InboxSummary {
  enabled: boolean;
  counts: {
    needsMyReview: number;
    submittedByMe: number;
    allPending: number;
    blocked: number;
    history: number;
  };
  truncated: boolean;
}

interface MemorySection {
  key: string;
  heading: string;
  owner: 'human' | 'engine';
  body: string;
}

interface MemoryReviewDetail extends MemoryReviewInboxItem {
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: MemorySection[];
    } | null;
  };
  feedbackReason: string | null;
  eligibleReviewers: Array<{ userId: string; name: string; role: string }>;
  timeline: Array<{
    candidateId: string;
    reviewRequestId: string;
    revisionNumber: number;
    predecessorCandidateId: string | null;
    supersededById: string | null;
    title: string;
    status: MemoryReviewStatus;
    submittedBy: { userId: string; name: string };
    assignedReviewer: { userId: string; name: string } | null;
    decidedBy: { userId: string; name: string } | null;
    createdAt: string;
    decidedAt: string | null;
  }>;
  controllingMemory: { itemId: string; version: number | null } | null;
  activeMemoryUnchanged: boolean;
}

interface NotificationItem {
  id: string;
  reviewRequestId: string;
  candidateId: string;
  clientId: string | null;
  eventType: string;
  title: string;
  readAt: string | null;
  createdAt: string;
}

interface NotificationPage {
  enabled: boolean;
  items: NotificationItem[];
  nextCursor: string | null;
}

type ReasonAction = 'reject' | 'request_changes' | 'reassign' | null;

export function memoryReviewStatusLabel(status: MemoryReviewStatus): string {
  const labels: Record<MemoryReviewStatus, string> = {
    pending: 'Pending review',
    changes_requested: 'Changes requested',
    approved: 'Approved',
    rejected: 'Rejected',
    withdrawn: 'Withdrawn',
    superseded: 'Revised',
  };
  return labels[status];
}

export function memoryReviewNextActionLabel(
  item: MemoryReviewInboxItem,
): string {
  switch (item.nextAction) {
    case 'review':
      return 'Your review is needed';
    case 'revise':
      return 'Revise and resubmit';
    case 'await_reviewer':
      return item.assignedReviewer
        ? `Waiting for ${item.assignedReviewer.name}`
        : 'Waiting for a reviewer';
    case 'assign_reviewer':
      return 'Assign an eligible reviewer';
    case 'none':
      return 'No action needed';
  }
}

export function memoryReviewBlockedReasonLabel(
  reason: MemoryReviewInboxItem['blockedReason'],
): string | null {
  if (reason === 'no_reviewer') return 'No reviewer is assigned.';
  if (reason === 'reviewer_unavailable') {
    return 'The assigned reviewer is no longer eligible.';
  }
  if (reason === 'archived_client') {
    return 'This client is not active, so review is paused.';
  }
  return null;
}

export function MemoryReviewInbox({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const [view, setView] = useState<MemoryReviewInboxView>('needs_my_review');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [selectedReviewRequestId, setSelectedReviewRequestId] = useState<
    string | null
  >(() => {
    const review = searchParams.get('review');
    return review && UUID_PATTERN.test(review) ? review : null;
  });
  const [reasonAction, setReasonAction] = useState<ReasonAction>(null);
  const [reason, setReason] = useState('');
  const [reviewerUserId, setReviewerUserId] = useState<string | undefined>();
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [revisionSections, setRevisionSections] = useState<MemorySection[]>([]);
  const [revisionValue, setRevisionValue] = useState('');

  const summary = useQuery<InboxSummary>({
    queryKey: ['memory-review-inbox-summary'],
    queryFn: async () =>
      (await api.get<InboxSummary>('/api/memory/review/inbox/summary')).data,
    staleTime: 10_000,
    retry: 1,
  });

  const inbox = useInfiniteQuery<InboxPage>({
    queryKey: ['memory-review-inbox', view],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.get<InboxPage>('/api/memory/review/inbox', {
          params: {
            view,
            limit: 25,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        })
      ).data,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: summary.data?.enabled === true,
    staleTime: 10_000,
    retry: 1,
  });

  const detail = useQuery<MemoryReviewDetail>({
    queryKey: [
      'memory-review-detail',
      selectedCandidateId,
      selectedReviewRequestId,
    ],
    queryFn: async () => {
      const path = selectedReviewRequestId
        ? `/api/memory/review/inbox/requests/${selectedReviewRequestId}`
        : `/api/memory/review/inbox/candidates/${selectedCandidateId}`;
      return (await api.get<MemoryReviewDetail>(path)).data;
    },
    enabled: Boolean(selectedCandidateId || selectedReviewRequestId),
    retry: 1,
  });

  const items = useMemo(
    () => inbox.data?.pages.flatMap((page) => page.items) ?? [],
    [inbox.data],
  );

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['memory-review-inbox'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-inbox-summary'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-detail'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] }),
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] }),
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] }),
    ]);
  };

  const action = useMutation({
    mutationFn: async (input: {
      path: string;
      body?: Record<string, unknown>;
    }) => (await api.post(input.path, input.body ?? {})).data,
    onSuccess: async () => {
      message.success('Memory review updated');
      setReasonAction(null);
      setReason('');
      setReviewerUserId(undefined);
      setRevisionOpen(false);
      await refresh();
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  const openCandidate = (candidateId: string) => {
    setSelectedReviewRequestId(null);
    setSelectedCandidateId(candidateId);
    const next = new URLSearchParams(searchParams);
    next.delete('review');
    setSearchParams(next, { replace: true });
  };

  const closeDetail = () => {
    setSelectedCandidateId(null);
    setSelectedReviewRequestId(null);
    const next = new URLSearchParams(searchParams);
    next.delete('review');
    setSearchParams(next, { replace: true });
  };

  const openRevision = () => {
    const current = detail.data;
    if (!current) return;
    setRevisionSections(
      current.proposal.canonicalItem?.sections.map((section) => ({ ...section })) ??
        [],
    );
    setRevisionValue(current.proposal.value ?? '');
    setRevisionOpen(true);
  };

  if (summary.isLoading) {
    return <Card loading aria-label="Loading memory review inbox" />;
  }
  if (summary.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Memory Review Inbox could not be loaded"
        description="Active memory is unchanged. Refresh before taking review action."
      />
    );
  }
  if (!summary.data?.enabled) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Shared memory review is unavailable"
        description="Firm and client proposals remain inactive until Memory Review is enabled."
      />
    );
  }

  const tabItems = [
    {
      key: 'needs_my_review',
      label: countLabel('Needs my review', summary.data.counts.needsMyReview),
    },
    {
      key: 'submitted_by_me',
      label: countLabel('Submitted by me', summary.data.counts.submittedByMe),
    },
    ...(isAdmin
      ? [
          {
            key: 'all_pending',
            label: countLabel('All pending', summary.data.counts.allPending),
          },
          {
            key: 'blocked',
            label: countLabel('Blocked', summary.data.counts.blocked),
          },
        ]
      : []),
    { key: 'history', label: countLabel('History', summary.data.counts.history) },
  ];

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Card aria-label="Memory Review Inbox">
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Space
            align="start"
            style={{ width: '100%', justifyContent: 'space-between' }}
          >
            <div>
              <Title level={4} style={{ marginBottom: 4 }}>
                Memory Review Inbox
              </Title>
              <Text type="secondary">
                Review shared memory, follow requested changes, and see who owns
                the next step.
              </Text>
            </div>
            <Button
              icon={<ReloadOutlined />}
              loading={inbox.isFetching}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          </Space>

          <Space wrap size="middle">
            <Statistic
              title="Needs my review"
              value={summary.data.counts.needsMyReview}
            />
            <Statistic
              title="Submitted by me"
              value={summary.data.counts.submittedByMe}
            />
            {isAdmin && (
              <Statistic
                title="Blocked"
                value={summary.data.counts.blocked}
                valueStyle={
                  summary.data.counts.blocked > 0
                    ? { color: '#cf1322' }
                    : undefined
                }
              />
            )}
          </Space>

          {summary.data.truncated && (
            <Alert
              type="info"
              showIcon
              message="Counts cover the most recent 1,000 review records"
            />
          )}

          <Tabs
            activeKey={view}
            items={tabItems}
            onChange={(key) => setView(key as MemoryReviewInboxView)}
          />

          {inbox.isLoading ? (
            <Spin />
          ) : inbox.isError ? (
            <Alert
              type="error"
              showIcon
              message="This review view could not be loaded"
            />
          ) : items.length === 0 ? (
            <Empty description={emptyDescription(view)} />
          ) : (
            <List
              dataSource={items}
              renderItem={(item) => (
                <List.Item
                  key={item.reviewRequestId}
                  actions={[
                    <Button
                      key="open"
                      type="link"
                      icon={<EyeOutlined />}
                      onClick={() => openCandidate(item.candidateId)}
                    >
                      Open
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space wrap>
                        <Text strong>{item.title}</Text>
                        <Tag color={statusColor(item.status)}>
                          {memoryReviewStatusLabel(item.status)}
                        </Tag>
                        <Tag>
                          {item.scope === 'client'
                            ? 'Client memory'
                            : 'Firm memory'}
                        </Tag>
                        {item.revisionNumber > 1 && (
                          <Tag>Revision {item.revisionNumber}</Tag>
                        )}
                      </Space>
                    }
                    description={
                      <Space direction="vertical" size={2}>
                        <Text type="secondary">
                          {item.client ? `${item.client.name} · ` : ''}
                          Submitted by {item.submittedBy.name} ·{' '}
                          {new Date(item.createdAt).toLocaleString()}
                        </Text>
                        <Text>{memoryReviewNextActionLabel(item)}</Text>
                        {memoryReviewBlockedReasonLabel(item.blockedReason) && (
                          <Text type="danger">
                            {memoryReviewBlockedReasonLabel(item.blockedReason)}
                          </Text>
                        )}
                      </Space>
                    }
                  />
                </List.Item>
              )}
            />
          )}

          {inbox.hasNextPage && (
            <Button
              block
              loading={inbox.isFetchingNextPage}
              onClick={() => void inbox.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </Space>
      </Card>

      <MemoryReviewNotifications onOpenCandidate={openCandidate} />

      <Drawer
        open={Boolean(selectedCandidateId || selectedReviewRequestId)}
        width={720}
        title={detail.data?.title ?? 'Memory review'}
        onClose={closeDetail}
        destroyOnClose
      >
        {detail.isLoading ? (
          <Spin />
        ) : detail.isError || !detail.data ? (
          <Alert
            type="warning"
            showIcon
            message="This review is no longer available to you"
            description="Assignment, membership, client access, or the ethical wall may have changed."
          />
        ) : (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Status">
                {memoryReviewStatusLabel(detail.data.status)}
              </Descriptions.Item>
              <Descriptions.Item label="Submitted by">
                {detail.data.submittedBy.name}
              </Descriptions.Item>
              <Descriptions.Item label="Assigned reviewer">
                {detail.data.assignedReviewer?.name ?? 'Not assigned'}
              </Descriptions.Item>
              <Descriptions.Item label="Next step">
                {memoryReviewNextActionLabel(detail.data)}
              </Descriptions.Item>
              {detail.data.client && (
                <Descriptions.Item label="Client">
                  {detail.data.client.name}
                </Descriptions.Item>
              )}
            </Descriptions>

            {detail.data.activeMemoryUnchanged && (
              <Alert
                type="info"
                showIcon
                message="Active memory is unchanged"
                description="This proposal remains separate until an independent reviewer approves it."
              />
            )}

            {detail.data.feedbackReason && (
              <Alert
                type="warning"
                showIcon
                message={
                  detail.data.status === 'changes_requested'
                    ? 'Reviewer requested changes'
                    : 'Reviewer feedback'
                }
                description={detail.data.feedbackReason}
              />
            )}

            <Card size="small" title="Proposed memory">
              {detail.data.proposal.canonicalItem?.sections.map((section) => (
                <div key={section.key} style={{ marginBottom: 16 }}>
                  <Text strong>{section.heading}</Text>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                    {section.body || '—'}
                  </Paragraph>
                </div>
              ))}
              {!detail.data.proposal.canonicalItem && (
                <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                  {detail.data.proposal.value || '—'}
                </Paragraph>
              )}
            </Card>

            <Space wrap>
              {detail.data.capabilities.approve && (
                <Button
                  type="primary"
                  icon={<CheckOutlined />}
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/memory/review/candidates/${detail.data.candidateId}/approve`,
                    })
                  }
                >
                  Approve
                </Button>
              )}
              {detail.data.capabilities.requestChanges && (
                <Button
                  icon={<EditOutlined />}
                  onClick={() => {
                    setReason('');
                    setReasonAction('request_changes');
                  }}
                >
                  Request changes
                </Button>
              )}
              {detail.data.capabilities.reject && (
                <Button
                  danger
                  icon={<CloseOutlined />}
                  onClick={() => {
                    setReason('');
                    setReasonAction('reject');
                  }}
                >
                  Reject
                </Button>
              )}
              {detail.data.capabilities.revise && (
                <Button
                  type="primary"
                  icon={<EditOutlined />}
                  onClick={openRevision}
                >
                  Revise and resubmit
                </Button>
              )}
              {detail.data.capabilities.reassign && (
                <Button
                  icon={<SwapOutlined />}
                  onClick={() => {
                    setReason('');
                    setReviewerUserId(detail.data?.assignedReviewer?.userId);
                    setReasonAction('reassign');
                  }}
                >
                  Assign reviewer
                </Button>
              )}
              {detail.data.capabilities.withdraw && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={action.isPending}
                  onClick={() =>
                    action.mutate({
                      path: `/api/memory/proposals/${detail.data.candidateId}/withdraw`,
                    })
                  }
                >
                  Withdraw
                </Button>
              )}
            </Space>

            <Card size="small" title="Revision history">
              <Timeline
                items={detail.data.timeline.map((entry) => ({
                  color:
                    entry.candidateId === detail.data?.candidateId
                      ? 'blue'
                      : 'gray',
                  children: (
                    <Space direction="vertical" size={0}>
                      <Text strong>
                        Revision {entry.revisionNumber} ·{' '}
                        {memoryReviewStatusLabel(entry.status)}
                      </Text>
                      <Text type="secondary">
                        Submitted by {entry.submittedBy.name} ·{' '}
                        {new Date(entry.createdAt).toLocaleString()}
                      </Text>
                      {entry.assignedReviewer && (
                        <Text type="secondary">
                          Reviewer: {entry.assignedReviewer.name}
                        </Text>
                      )}
                    </Space>
                  ),
                }))}
              />
            </Card>
          </Space>
        )}
      </Drawer>

      <Modal
        open={reasonAction !== null}
        title={reasonModalTitle(reasonAction)}
        okText={reasonAction === 'reassign' ? 'Assign reviewer' : 'Confirm'}
        okButtonProps={{
          danger: reasonAction === 'reject',
          disabled:
            !reason.trim() || (reasonAction === 'reassign' && !reviewerUserId),
        }}
        confirmLoading={action.isPending}
        onCancel={() => {
          setReasonAction(null);
          setReason('');
          setReviewerUserId(undefined);
        }}
        onOk={() => {
          const current = detail.data;
          if (!current || !reasonAction || !reason.trim()) return;
          if (reasonAction === 'reassign') {
            if (!reviewerUserId) return;
            action.mutate({
              path: `/api/memory/review/candidates/${current.candidateId}/assign`,
              body: { reviewerUserId, reason: reason.trim() },
            });
            return;
          }
          action.mutate({
            path: `/api/memory/review/candidates/${current.candidateId}/${
              reasonAction === 'request_changes' ? 'request-changes' : 'reject'
            }`,
            body: { reason: reason.trim() },
          });
        }}
        destroyOnClose
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          {reasonAction === 'reassign' && (
            <Select
              style={{ width: '100%' }}
              placeholder="Choose an eligible reviewer"
              value={reviewerUserId}
              options={detail.data?.eligibleReviewers.map((reviewer) => ({
                value: reviewer.userId,
                label: reviewer.name,
              }))}
              onChange={setReviewerUserId}
            />
          )}
          <Input.TextArea
            aria-label="Review reason"
            rows={4}
            maxLength={500}
            showCount
            value={reason}
            placeholder="Explain what needs to happen next"
            onChange={(event) => setReason(event.target.value)}
          />
        </Space>
      </Modal>

      <Modal
        open={revisionOpen}
        title="Revise memory proposal"
        okText="Submit revision"
        okButtonProps={{
          disabled:
            revisionSections.length > 0
              ? revisionSections.every((section) => !section.body.trim())
              : !revisionValue.trim(),
        }}
        confirmLoading={action.isPending}
        onCancel={() => setRevisionOpen(false)}
        onOk={() => {
          const current = detail.data;
          if (!current) return;
          action.mutate({
            path: `/api/memory/review/candidates/${current.candidateId}/revise`,
            body:
              revisionSections.length > 0
                ? { sections: revisionSections }
                : { value: revisionValue },
          });
        }}
        width={720}
        destroyOnClose
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="A revision creates a new immutable proposal"
            description="The prior proposal remains in history and active memory stays unchanged."
          />
          {revisionSections.length > 0 ? (
            revisionSections.map((section, index) => (
              <div key={section.key}>
                <Text strong>{section.heading}</Text>
                <Input.TextArea
                  rows={5}
                  value={section.body}
                  maxLength={50_000}
                  onChange={(event) =>
                    setRevisionSections((current) =>
                      current.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? { ...candidate, body: event.target.value }
                          : candidate,
                      ),
                    )
                  }
                />
              </div>
            ))
          ) : (
            <Input.TextArea
              rows={10}
              value={revisionValue}
              maxLength={200_000}
              onChange={(event) => setRevisionValue(event.target.value)}
            />
          )}
        </Space>
      </Modal>
    </Space>
  );
}

function MemoryReviewNotifications({
  onOpenCandidate,
}: {
  onOpenCandidate: (candidateId: string) => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const notifications = useQuery<NotificationPage>({
    queryKey: ['memory-review-notifications'],
    queryFn: async () =>
      (
        await api.get<NotificationPage>('/api/memory/review/notifications', {
          params: { limit: 10 },
        })
      ).data,
    staleTime: 10_000,
    retry: 1,
  });
  const unread = useQuery<{ enabled: boolean; count: number }>({
    queryKey: ['memory-review-notification-count'],
    queryFn: async () =>
      (
        await api.get<{ enabled: boolean; count: number }>(
          '/api/memory/review/notifications/unread-count',
        )
      ).data,
    staleTime: 10_000,
    retry: 1,
  });
  const markRead = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/memory/review/notifications/${id}/read`, {})).data,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
        qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      ]);
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });
  const markAll = useMutation({
    mutationFn: async () =>
      (await api.post('/api/memory/review/notifications/read-all', {})).data,
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['memory-review-notifications'] }),
        qc.invalidateQueries({ queryKey: ['memory-review-notification-count'] }),
      ]);
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  if (notifications.data?.enabled === false) return null;

  return (
    <Card
      title={
        <Space>
          <BellOutlined />
          <span>Review notifications</span>
          <Badge count={unread.data?.count ?? 0} />
        </Space>
      }
      extra={
        (unread.data?.count ?? 0) > 0 ? (
          <Button
            type="link"
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        ) : null
      }
    >
      {notifications.isLoading ? (
        <Spin />
      ) : notifications.data?.items.length ? (
        <List
          dataSource={notifications.data.items}
          renderItem={(notification) => (
            <List.Item
              key={notification.id}
              style={{
                opacity: notification.readAt ? 0.72 : 1,
                cursor: 'pointer',
              }}
              onClick={() => {
                if (!notification.readAt) markRead.mutate(notification.id);
                onOpenCandidate(notification.candidateId);
              }}
            >
              <List.Item.Meta
                title={notification.title}
                description={new Date(notification.createdAt).toLocaleString()}
              />
              {!notification.readAt && <Badge status="processing" text="New" />}
            </List.Item>
          )}
        />
      ) : (
        <Empty description="No memory review notifications" />
      )}
    </Card>
  );
}

function countLabel(label: string, count: number) {
  return (
    <Space size={6}>
      <span>{label}</span>
      <Badge count={count} showZero overflowCount={999} />
    </Space>
  );
}

function emptyDescription(view: MemoryReviewInboxView): string {
  const descriptions: Record<MemoryReviewInboxView, string> = {
    needs_my_review: 'Nothing needs your review',
    submitted_by_me: 'You have no open shared-memory submissions',
    all_pending: 'No shared-memory proposals are pending',
    blocked: 'No review workflows are blocked',
    history: 'No completed memory reviews yet',
  };
  return descriptions[view];
}

function statusColor(status: MemoryReviewStatus): string {
  if (status === 'approved') return 'green';
  if (status === 'rejected') return 'red';
  if (status === 'changes_requested') return 'orange';
  if (status === 'pending') return 'blue';
  return 'default';
}

function reasonModalTitle(action: ReasonAction): string {
  if (action === 'request_changes') return 'Request changes';
  if (action === 'reassign') return 'Assign an eligible reviewer';
  return 'Reject memory proposal';
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (
      error as { response?: { data?: { message?: unknown } } }
    ).response;
    if (typeof response?.data?.message === 'string') {
      return response.data.message;
    }
  }
  return error instanceof Error ? error.message : 'Memory review action failed';
}
