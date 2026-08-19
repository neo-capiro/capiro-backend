import { Alert, Card, Col, Descriptions, Empty, Row, Space, Tag, Typography } from 'antd';

const { Paragraph, Text, Title } = Typography;

// Types + copy helpers extracted to pending-memory-review-shared.ts (UI-free)
// so the vNext Settings module shares them. Re-exported to keep this file's
// public API unchanged.
export {
  activeMemoryReviewExplanation,
  activeMemoryVersionPresentation,
  pendingReviewHeadline,
  pendingReviewTone,
  type MemoryReviewSection,
  type MemoryReviewerIdentity,
  type PendingMemoryReviewState,
} from './pending-memory-review-shared.js';
import {
  activeMemoryReviewExplanation,
  activeMemoryVersionPresentation,
  pendingReviewHeadline,
  pendingReviewTone,
  type MemoryReviewSection,
  type PendingMemoryReviewState,
} from './pending-memory-review-shared.js';

export function PendingMemoryReviewPanel({
  activeExists,
  activeSections,
  pending,
}: {
  activeExists: boolean;
  activeSections: MemoryReviewSection[];
  pending: PendingMemoryReviewState;
}) {
  const reviewers = pending.eligibleReviewers ?? [];
  const proposalSections = pending.proposal?.sections ?? [];
  const activePresentation = activeMemoryVersionPresentation(activeExists);
  const showAuditDetails = Boolean(
    pending.submittedBy || pending.viewerCanReview || pending.canWithdraw,
  );

  return (
    <Card
      aria-label="Pending memory review"
      style={{ borderColor: pending.blocked ? '#ffccc7' : undefined }}
    >
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Alert
          type={pendingReviewTone(pending)}
          showIcon
          message={pendingReviewHeadline(pending)}
          description={
            <Space direction="vertical" size={2}>
              <Text>
                {pending.nextAction ?? 'The active version remains unchanged until approval.'}
              </Text>
              {pending.submittedBy && (
                <Text type="secondary">
                  Submitted by {pending.submittedBy.name} on {formatDate(pending.submittedAt)}.
                </Text>
              )}
            </Space>
          }
        />

        <Descriptions bordered size="small" column={{ xs: 1, sm: 1, md: 2 }}>
          <Descriptions.Item label="Status">
            <Tag color={pending.blocked ? 'red' : 'blue'}>{pendingReviewHeadline(pending)}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Applies to">
            {pending.scope === 'client' ? 'This client' : 'The firm'}
          </Descriptions.Item>
          <Descriptions.Item label="Approver needed">
            {pending.reviewerRequirement ?? 'An authorized administrator or reviewer'}
          </Descriptions.Item>
          <Descriptions.Item label="Eligible approvers">
            {reviewers.length > 0 ? (
              <Space wrap>
                {reviewers.map((reviewer) => (
                  <Tag key={reviewer.userId}>{reviewer.name}</Tag>
                ))}
              </Space>
            ) : pending.blocked ? (
              <Text type="danger">None currently available</Text>
            ) : (
              <Text type="secondary">Available to authorized administrators and reviewers</Text>
            )}
          </Descriptions.Item>
        </Descriptions>

        <div>
          <Title level={5} style={{ marginBottom: 8 }}>
            Current and proposed memory
          </Title>
          <Text type="secondary">{activeMemoryReviewExplanation(activeExists)}</Text>
        </div>

        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <MemoryVersionCard
              title={activePresentation.title}
              tag={activePresentation.tag}
              tagColor={activePresentation.tagColor}
              sections={activeExists ? activeSections : []}
            />
          </Col>
          <Col xs={24} lg={12}>
            <MemoryVersionCard
              title={
                pending.proposal?.title ? `Proposed: ${pending.proposal.title}` : 'Proposed version'
              }
              tag="Not active yet"
              tagColor="gold"
              sections={proposalSections}
            />
          </Col>
        </Row>

        {showAuditDetails && (
          <details>
            <summary style={{ cursor: 'pointer' }}>Audit details</summary>
            <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
              Review reference: <Text code>{pending.auditReference ?? pending.candidateId}</Text>
            </Paragraph>
          </details>
        )}
      </Space>
    </Card>
  );
}

function MemoryVersionCard({
  title,
  tag,
  tagColor,
  sections,
}: {
  title: string;
  tag: string;
  tagColor: 'green' | 'gold' | 'default';
  sections: MemoryReviewSection[];
}) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Text strong>{title}</Text>
          <Tag color={tagColor}>{tag}</Tag>
        </Space>
        {sections.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No content in this version" />
        ) : (
          sections.map((section) => (
            <section key={section.key}>
              <Text strong>{section.heading}</Text>
              <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {section.body || '—'}
              </Paragraph>
            </section>
          ))
        )}
      </Space>
    </Card>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}
