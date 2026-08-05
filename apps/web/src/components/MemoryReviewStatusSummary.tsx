import { Alert, Card, Space, Statistic, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';

const { Text, Title } = Typography;

export interface MemoryReviewSummaryResponse {
  enabled: boolean;
  counts: {
    awaitingMyReview: number;
    submittedByMe: number;
    allPending: number;
    blocked: number;
  };
  message: string | null;
}

export function memoryReviewSummaryStats(summary: MemoryReviewSummaryResponse) {
  return [
    { key: 'awaiting', title: 'Needs my review', value: summary.counts.awaitingMyReview },
    { key: 'submitted', title: 'Submitted by me', value: summary.counts.submittedByMe },
    { key: 'all', title: 'All pending I can see', value: summary.counts.allPending },
    { key: 'blocked', title: 'Blocked', value: summary.counts.blocked },
  ] as const;
}

/** The plain-language status strip for shared memory review. */
export function MemoryReviewStatusSummary() {
  const api = useApi();
  const summary = useQuery<MemoryReviewSummaryResponse>({
    queryKey: ['memory-review-summary'],
    queryFn: async () =>
      (await api.get<MemoryReviewSummaryResponse>('/api/memory/review/summary')).data,
    staleTime: 15_000,
    retry: 1,
  });

  if (summary.isLoading) return <Card loading aria-label="Loading memory review status" />;
  if (summary.isError) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Memory review status could not be loaded"
        description="Your active memory is unchanged. Refresh before submitting shared memory."
      />
    );
  }
  if (!summary.data) return null;

  if (!summary.data.enabled) {
    return (
      <Alert
        type="warning"
        showIcon
        message="Shared memory review is unavailable"
        description={summary.data.message ?? 'Firm and client submissions are disabled.'}
      />
    );
  }

  return (
    <Card aria-label="Memory review status">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Title level={4} style={{ marginBottom: 4 }}>
            Memory review
          </Title>
          <Text type="secondary">
            Shared firm and client memory becomes active only after an independent reviewer approves
            it.
          </Text>
        </div>
        <Space wrap size="middle">
          {memoryReviewSummaryStats(summary.data).map((stat) => (
            <Card key={stat.key} size="small" style={{ minWidth: 165 }}>
              <Statistic
                title={stat.title}
                value={stat.value}
                valueStyle={
                  stat.key === 'blocked' && stat.value > 0 ? { color: '#cf1322' } : undefined
                }
              />
            </Card>
          ))}
        </Space>
        {summary.data.message && (
          <Alert
            type="error"
            showIcon
            message="Review action required"
            description={summary.data.message}
          />
        )}
      </Space>
    </Card>
  );
}
