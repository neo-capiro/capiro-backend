import { Alert, Card, Space } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../lib/use-api.js';
import { MemoryGovernanceCenter } from './MemoryGovernanceCenter.js';
import { MemoryProposalQueue } from './MemoryProposalQueue.js';
import { MemoryReviewQueue } from './MemoryReviewQueue.js';

interface CenterAvailability {
  enabled: boolean;
}

/**
 * Dark-rollout host. Standard users always keep their existing queues. Admins
 * receive the center only after the server explicitly arms it; off/error states
 * preserve the pre-Phase-15 product instead of making review work disappear.
 */
export function MemoryGovernanceCenterHost({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const availability = useQuery<CenterAvailability>({
    queryKey: ['memory-governance-availability'],
    queryFn: async () => (await api.get<CenterAvailability>('/api/memory/governance')).data,
    enabled: isAdmin,
    retry: 1,
    staleTime: 10_000,
  });

  if (!isAdmin) return <LegacyMemoryQueues />;
  if (availability.isLoading) return <Card loading aria-label="Loading memory governance" />;
  if (availability.data?.enabled) return <MemoryGovernanceCenter isAdmin />;

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {availability.isError && (
        <Alert
          type="warning"
          showIcon
          message="Governance Center unavailable; existing review queues remain available"
        />
      )}
      <LegacyMemoryQueues />
    </Space>
  );
}

function LegacyMemoryQueues() {
  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <MemoryProposalQueue />
      <MemoryReviewQueue />
    </Space>
  );
}
