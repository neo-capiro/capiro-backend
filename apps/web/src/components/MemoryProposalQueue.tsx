import { App, Button, Card, Space, Tag, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Paragraph, Text, Title } = Typography;

// Types + helpers extracted to memory-queue-shared.ts (UI-free) so the vNext
// Settings module shares them. Re-exported to keep this file's public API
// unchanged.
export {
  ownedMemoryCandidateStatusLabel,
  ownedMemoryCandidateTitle,
  shouldRenderMemoryProposalQueue,
  type OwnedMemoryCandidate,
  type OwnedMemoryCandidateStatus,
} from './memory-queue-shared.js';
import {
  ownedMemoryCandidateStatusLabel,
  ownedMemoryCandidateTitle,
  shouldRenderMemoryProposalQueue,
  type OwnedProposalQueueResponse as ProposalQueueResponse,
} from './memory-queue-shared.js';

/**
 * Proposer-owned history. The server returns only the current user's candidates;
 * a client proposal whose wall access was removed is redacted but a pending row
 * remains safely withdrawable. The browser never converts Withdraw into reviewer
 * rejection, and terminal labels preserve who made the disposition.
 */
export function MemoryProposalQueue() {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = App.useApp();

  const queue = useQuery<ProposalQueueResponse>({
    queryKey: ['memory-own-proposals'],
    queryFn: async () => (await api.get<ProposalQueueResponse>('/api/memory/proposals')).data,
    staleTime: 15_000,
    retry: 1,
  });

  const withdraw = useMutation({
    mutationFn: async (id: string) =>
      (await api.post(`/api/memory/proposals/${id}/withdraw`, {})).data,
    onSuccess: () => {
      message.success('Proposal withdrawn');
      qc.invalidateQueries({ queryKey: ['memory-own-proposals'] });
      qc.invalidateQueries({ queryKey: ['memory-review-candidates'] });
      qc.invalidateQueries({ queryKey: ['memory-review-summary'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-overview'] });
      qc.invalidateQueries({ queryKey: ['memory-governance-transitions'] });
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) =>
      message.error(error instanceof Error ? error.message : 'Withdrawal failed'),
  });

  if (!shouldRenderMemoryProposalQueue(queue.data)) return null;

  return (
    <Card aria-label="Your memory proposal history">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ marginBottom: 4 }}>
            Your proposals
          </Title>
          <Text type="secondary">
            Withdraw a pending proposal you no longer want reviewed. History distinguishes your
            withdrawal from a reviewer rejection.
          </Text>
        </div>

        {queue.data?.candidates.map((candidate) => (
          <Card key={candidate.id} size="small">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Space wrap>
                <Text strong>{ownedMemoryCandidateTitle(candidate)}</Text>
                <Tag>{candidate.scope === 'client' ? 'Client memory' : 'Firm memory'}</Tag>
                <Tag>{ownedMemoryCandidateStatusLabel(candidate.status)}</Tag>
                <Text type="secondary">
                  Submitted {new Date(candidate.createdAt).toLocaleString()}
                </Text>
                {candidate.decidedAt && (
                  <Text type="secondary">
                    Decided {new Date(candidate.decidedAt).toLocaleString()}
                  </Text>
                )}
              </Space>

              {candidate.restricted && (
                <Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  Proposal content is hidden because you no longer have access to this client&apos;s
                  memory.
                  {candidate.capabilities.withdraw ? ' You may still withdraw it.' : ''}
                </Paragraph>
              )}

              {candidate.proposal?.canonicalItem?.sections.map((section) => (
                <div key={section.key}>
                  <Text strong>{section.heading}</Text>
                  <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                    {section.body || '—'}
                  </Paragraph>
                </div>
              ))}

              {!candidate.proposal?.canonicalItem && candidate.proposal?.value && (
                <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 4 }}>
                  {candidate.proposal.value}
                </Paragraph>
              )}

              {candidate.capabilities.withdraw && (
                <Button
                  danger
                  icon={<StopOutlined />}
                  loading={withdraw.isPending && withdraw.variables === candidate.id}
                  onClick={() => withdraw.mutate(candidate.id)}
                >
                  Withdraw
                </Button>
              )}
            </Space>
          </Card>
        ))}
      </Space>
    </Card>
  );
}
