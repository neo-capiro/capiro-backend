import { App, Button, Card, Space, Tag, Typography } from 'antd';
import { StopOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Paragraph, Text, Title } = Typography;

export interface OwnedMemoryCandidate {
  id: string;
  scope: string;
  clientId: string | null;
  sourceKind: string;
  createdAt: string;
  restricted: boolean;
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
  } | null;
  capabilities: { withdraw: true };
}

interface ProposalQueueResponse {
  enabled: boolean;
  candidates: OwnedMemoryCandidate[];
}

export function ownedMemoryCandidateTitle(candidate: OwnedMemoryCandidate): string {
  if (candidate.restricted) return 'Restricted client memory proposal';
  return candidate.proposal?.canonicalItem?.title ?? candidate.proposal?.key ?? 'Memory proposal';
}

export function shouldRenderMemoryProposalQueue(
  response: ProposalQueueResponse | undefined,
): boolean {
  return response?.enabled === true && response.candidates.length > 0;
}

/**
 * Proposer-owned queue. The server returns only the current user's candidates;
 * a client proposal whose wall access was removed is redacted but remains safely
 * withdrawable. The browser never converts Withdraw into reviewer rejection.
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
      qc.invalidateQueries({ queryKey: ['memory-item'] });
    },
    onError: (error: unknown) =>
      message.error(error instanceof Error ? error.message : 'Withdrawal failed'),
  });

  if (!shouldRenderMemoryProposalQueue(queue.data)) return null;

  return (
    <Card aria-label="Your pending memory proposals">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ marginBottom: 4 }}>
            Your pending proposals
          </Title>
          <Text type="secondary">
            Withdraw a proposal you no longer want reviewed. Withdrawal is not a reviewer rejection.
          </Text>
        </div>

        {queue.data?.candidates.map((candidate) => (
          <Card key={candidate.id} size="small">
            <Space direction="vertical" size="small" style={{ width: '100%' }}>
              <Space wrap>
                <Text strong>{ownedMemoryCandidateTitle(candidate)}</Text>
                <Tag>{candidate.scope === 'client' ? 'Client memory' : 'Firm memory'}</Tag>
                <Text type="secondary">
                  Submitted {new Date(candidate.createdAt).toLocaleString()}
                </Text>
              </Space>

              {candidate.restricted && (
                <Paragraph type="secondary" style={{ marginBottom: 4 }}>
                  Proposal content is hidden because you no longer have access to this client's memory.
                  You may still withdraw it.
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
