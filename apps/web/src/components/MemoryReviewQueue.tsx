import { useState } from 'react';
import { App, Button, Card, Empty, Input, Modal, Space, Tag, Typography } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Paragraph, Text, Title } = Typography;

export type MemoryCandidateKind = 'standard' | 'correction' | 'restore' | 'contradiction';

export interface ReviewableMemoryCandidate {
  id: string;
  candidateKind: MemoryCandidateKind;
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

export function memoryCandidateKindLabel(kind: MemoryCandidateKind): string {
  const labels: Record<MemoryCandidateKind, string> = {
    standard: 'New memory',
    correction: 'Correction',
    restore: 'Restore',
    contradiction: 'Contradiction',
  };
  return labels[kind];
}

export function candidateRejectRequiresReason(candidate: ReviewableMemoryCandidate): boolean {
  return candidate.candidateKind !== 'standard';
}

export function memoryReviewOutcomeMessage(
  result: Record<string, unknown>,
  decision: 'approve' | 'reject',
): string {
  const outcome = String(result.outcome ?? decision);
  const kind = String(result.candidateKind ?? 'standard');
  if (outcome === 'activated') {
    return kind === 'standard' ? 'Memory approved' : 'Memory version activated';
  }
  if (outcome === 'duplicate') return 'Existing controlling memory confirmed';
  if (outcome === 'conflict') return 'Memory conflict opened for resolution';
  if (outcome === 'rejected' || decision === 'reject') return 'Memory rejected';
  return decision === 'approve' ? 'Memory approved' : 'Memory rejected';
}

export function shouldRenderMemoryReviewQueue(response: ReviewQueueResponse | undefined): boolean {
  return response?.enabled === true && response.candidates.length > 0;
}

/** Server-filtered reviewer queue used by standard reviewers and administrators. */
export function MemoryReviewQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [rejecting, setRejecting] = useState<ReviewableMemoryCandidate | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const queue = useQuery<ReviewQueueResponse>({
    queryKey: ['memory-review-candidates'],
    queryFn: async () => (await api.get<ReviewQueueResponse>('/api/memory/review/candidates')).data,
    staleTime: 15_000,
    retry: 1,
  });

  const decision = useMutation({
    mutationFn: async (input: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      (
        await api.post(`/api/memory/review/candidates/${input.id}/${input.decision}`, {
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ).data,
    onSuccess: (result: Record<string, unknown>, input) => {
      message.success(memoryReviewOutcomeMessage(result, input.decision));
      setRejecting(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-items'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) => message.error(errorMessage(error)),
  });

  if (!shouldRenderMemoryReviewQueue(queue.data)) return null;

  const rejectCandidate = (candidate: ReviewableMemoryCandidate) => {
    if (!candidateRejectRequiresReason(candidate)) {
      decision.mutate({ id: candidate.id, decision: 'reject' });
      return;
    }
    setRejectReason('');
    setRejecting(candidate);
  };

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
                <Tag>{memoryCandidateKindLabel(candidate.candidateKind)}</Tag>
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
                    onClick={() => rejectCandidate(candidate)}
                  >
                    Reject
                  </Button>
                )}
              </Space>
            </Space>
          </Card>
        ))}
      </Space>

      <Modal
        open={Boolean(rejecting)}
        title={`Reject ${rejecting ? memoryCandidateKindLabel(rejecting.candidateKind).toLowerCase() : 'proposal'}`}
        okText="Reject proposal"
        okButtonProps={{ danger: true, disabled: rejectReason.trim().length === 0 }}
        confirmLoading={decision.isPending}
        onCancel={() => {
          setRejecting(null);
          setRejectReason('');
        }}
        onOk={() => {
          if (!rejecting || !rejectReason.trim()) return;
          decision.mutate({
            id: rejecting.id,
            decision: 'reject',
            reason: rejectReason.trim(),
          });
        }}
        destroyOnClose
      >
        <Paragraph type="secondary">
          The reason becomes bounded transition evidence; proposal content is not copied into the
          audit ledger.
        </Paragraph>
        <Input.TextArea
          aria-label="Rejection reason"
          rows={4}
          value={rejectReason}
          maxLength={500}
          showCount
          onChange={(event) => setRejectReason(event.target.value)}
        />
      </Modal>
    </Card>
  );
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    if (typeof response?.data?.message === 'string') return response.data.message;
  }
  return error instanceof Error ? error.message : 'Review decision failed';
}
