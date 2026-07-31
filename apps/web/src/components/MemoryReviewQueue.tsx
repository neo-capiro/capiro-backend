import { App, Button, Card, Empty, Space, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Paragraph, Text, Title } = Typography;

export interface ReviewableMemoryCandidate {
  id: string;
  scope: string;
  clientId: string | null;
  proposedByUserId: string;
  sourceKind: string;
  createdAt: string;
  proposal: {
    key: string | null;
    value: string | null;
    canonicalItem: {
      type: string;
      slug: string;
      title: string;
      sections: Array<{
        key: string;
        heading: string;
        owner: 'human' | 'engine';
        body: string;
      }>;
    } | null;
  };
  capabilities: {
    approve: boolean;
    reject: boolean;
  };
}

interface ReviewQueueResponse {
  enabled: boolean;
  candidates: ReviewableMemoryCandidate[];
}

export function memoryReviewCandidateTitle(candidate: ReviewableMemoryCandidate): string {
  return candidate.proposal.canonicalItem?.title ?? candidate.proposal.key ?? 'Memory proposal';
}

export function shouldRenderMemoryReviewQueue(response: ReviewQueueResponse | undefined): boolean {
  return response?.enabled === true && response.candidates.length > 0;
}

/**
 * Reviewer queue shown in Settings → Memory.
 *
 * The browser does not decide candidate visibility or authority. The API returns
 * only candidates the authenticated actor may inspect and supplies server-derived
 * approve/reject capabilities. A standard user with a valid client grant sees
 * only that client's proposals; unrelated and walled clients never reach this UI.
 */
export function MemoryReviewQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const queue = useQuery<ReviewQueueResponse>({
    queryKey: ['memory-review-candidates'],
    queryFn: async () => (await api.get<ReviewQueueResponse>('/api/memory/review/candidates')).data,
    staleTime: 15_000,
    retry: 1,
  });

  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject' }) =>
      (await api.post(`/api/memory/review/candidates/${input.id}/${input.decision}`, {})).data,
    onSuccess: (_result, input) => {
      message.success(input.decision === 'approve' ? 'Memory approved' : 'Memory rejected');
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) =>
      message.error(error instanceof Error ? error.message : 'Review decision failed'),
  });

  if (!shouldRenderMemoryReviewQueue(queue.data)) return null;

  return (
    <Card aria-label="Memory proposals awaiting your review">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ marginBottom: 4 }}>
            Awaiting your review
          </Title>
          <Text type="secondary">
            These proposals are limited to the firm or clients you are authorized to review.
          </Text>
        </div>

        {queue.data?.candidates.length === 0 && <Empty description="No proposals to review" />}

        {queue.data?.candidates.map((candidate) => (
          <Card key={candidate.id} size="small">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Space wrap>
                <Text strong>{memoryReviewCandidateTitle(candidate)}</Text>
                <Tag>{candidate.scope === 'client' ? 'Client memory' : 'Firm memory'}</Tag>
                <Text type="secondary">
                  Submitted {new Date(candidate.createdAt).toLocaleString()}
                </Text>
              </Space>

              {candidate.proposal.canonicalItem?.sections.map((section) => (
                <div key={section.key}>
                  <Text strong>{section.heading}</Text>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                    {section.body || '—'}
                  </Paragraph>
                </div>
              ))}

              {!candidate.proposal.canonicalItem && candidate.proposal.value && (
                <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                  {candidate.proposal.value}
                </Paragraph>
              )}

              <Space>
                {candidate.capabilities.approve && (
                  <Button
                    type="primary"
                    icon={<CheckOutlined />}
                    loading={decision.isPending && decision.variables?.id === candidate.id}
                    onClick={() => decision.mutate({ id: candidate.id, decision: 'approve' })}
                  >
                    Approve
                  </Button>
                )}
                {candidate.capabilities.reject && (
                  <Button
                    danger
                    icon={<CloseOutlined />}
                    loading={decision.isPending && decision.variables?.id === candidate.id}
                    onClick={() => decision.mutate({ id: candidate.id, decision: 'reject' })}
                  >
                    Reject
                  </Button>
                )}
              </Space>
            </Space>
          </Card>
        ))}
      </Space>
    </Card>
  );
}
