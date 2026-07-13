/**
 * One held-deliverable review (§3.3). Shows why it was held (the auditor reason)
 * + risk tier + surface, and the decision controls: approve (releases the
 * deliverable) / reject, plus an admin-only Assign picker. The server is the real
 * authz boundary (assertMayDecide: admin OR the named reviewer, never the
 * requester) — the buttons are an affordance; a non-permitted decide surfaces the
 * 403 via message.error rather than being hidden.
 */
import { useState } from 'react';
import { App as AntApp, Button, Card, Popconfirm, Select, Space, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined, UserOutlined } from '@ant-design/icons';
import {
  useApproveReview,
  useAssignReview,
  useRejectReview,
  type TeamMemberOption,
} from './reviews-api.js';
import {
  RISK_TIER_COLORS,
  RISK_TIER_LABELS,
  STATUS_COLORS,
  STATUS_LABELS,
  SURFACE_LABELS,
  type ReviewRequestDto,
} from './types.js';

const { Text, Paragraph } = Typography;

function memberName(m: TeamMemberOption): string {
  const full = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return full || m.email || m.userId;
}

export function ReviewCard({
  review,
  isAdmin,
  teamMembers,
}: {
  review: ReviewRequestDto;
  isAdmin: boolean;
  teamMembers: TeamMemberOption[];
}) {
  const { message } = AntApp.useApp();
  const approve = useApproveReview();
  const reject = useRejectReview();
  const assign = useAssignReview();
  const [assigning, setAssigning] = useState(false);

  const members = Array.isArray(teamMembers) ? teamMembers : [];
  const isPending = review.status === 'pending';
  const busy = approve.isPending || reject.isPending || assign.isPending;

  const assignedName = review.assignedTo
    ? (members.find((m) => m.userId === review.assignedTo)
        ? memberName(members.find((m) => m.userId === review.assignedTo)!)
        : 'Assigned')
    : null;

  function handleApprove() {
    approve.mutate(
      { id: review.id },
      {
        onSuccess: (res) => {
          const file = res?.released?.fileName;
          message.success(file ? `Approved & filed "${file}"` : 'Approved & released');
        },
        onError: (err) => message.error(err.message || 'Could not approve'),
      },
    );
  }

  function handleReject() {
    reject.mutate(
      { id: review.id },
      {
        onSuccess: () => message.success('Rejected — the deliverable stays unfiled'),
        onError: (err) => message.error(err.message || 'Could not reject'),
      },
    );
  }

  function handleAssign(userId: string) {
    setAssigning(true);
    assign.mutate(
      { id: review.id, userId },
      {
        onSuccess: () => message.success('Reviewer assigned'),
        onError: (err) => message.error(err.message || 'Could not assign'),
        onSettled: () => setAssigning(false),
      },
    );
  }

  return (
    <Card size="small" style={{ width: '100%' }}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Space wrap size={6}>
          <Tag color={RISK_TIER_COLORS[review.riskTier]}>{RISK_TIER_LABELS[review.riskTier]}</Tag>
          <Tag>{SURFACE_LABELS[review.surface] ?? review.surface}</Tag>
          <Tag color={STATUS_COLORS[review.status]}>{STATUS_LABELS[review.status]}</Tag>
        </Space>

        <Text strong style={{ fontSize: 15 }}>
          {review.title}
        </Text>

        <Paragraph type="secondary" style={{ margin: 0 }}>
          {review.reason}
        </Paragraph>

        <Space size={16} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Held {new Date(review.createdAt).toLocaleDateString()}
          </Text>
          {assignedName ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              <UserOutlined /> {assignedName}
            </Text>
          ) : null}
        </Space>

        {isPending ? (
          <Space wrap style={{ marginTop: 4 }}>
            <Popconfirm
              title="Approve & release this deliverable?"
              description="Approving files the held deliverable into the client record."
              okText="Approve"
              onConfirm={handleApprove}
              disabled={busy}
            >
              <Button type="primary" icon={<CheckOutlined />} loading={approve.isPending} disabled={busy && !approve.isPending}>
                Approve
              </Button>
            </Popconfirm>
            <Popconfirm
              title="Reject this deliverable?"
              description="Rejecting leaves it unfiled; nothing is sent to the client."
              okText="Reject"
              okButtonProps={{ danger: true }}
              onConfirm={handleReject}
              disabled={busy}
            >
              <Button danger icon={<CloseOutlined />} loading={reject.isPending} disabled={busy && !reject.isPending}>
                Reject
              </Button>
            </Popconfirm>
            {isAdmin ? (
              <Select
                placeholder="Assign reviewer…"
                style={{ minWidth: 200 }}
                value={review.assignedTo ?? undefined}
                loading={assigning}
                disabled={busy && !assign.isPending}
                onChange={handleAssign}
                options={members.map((m) => ({ value: m.userId, label: memberName(m) }))}
                notFoundContent={members.length === 0 ? 'No team members' : undefined}
              />
            ) : null}
          </Space>
        ) : null}
      </Space>
    </Card>
  );
}
